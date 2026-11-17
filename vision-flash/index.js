/**
 * Purpose-driven vision switching for text-only main models.
 *
 * The session's main model keeps every text and reasoning task. Whenever an
 * image must be understood, the `vision_analyze` tool streams that image plus
 * the caller's question through the harness LLM seam to a vision-capable route
 * and returns its answer as text evidence.
 *
 * The vision route is discovered, not hard-coded: every registered provider is
 * interrogated through `ctx.llm.listModels()` and only models whose catalog
 * declares an `image` input modality become candidates. Candidates are then
 * tried in order, so a provider switch, a new endpoint, or one route burning
 * its weekly quota no longer breaks vision — the tool falls through to the next
 * route that can actually see pixels. Credentials stay on the configured
 * provider route; this plugin never touches API keys.
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { basename, extname } from "node:path";

const name = "dsh-vision-flash";
const inject = ["tools", "llm", "attachments", "fs"];

/** Candidate ranking: substrings of `provider/model`, best first. Vision-specialised ids win; after that the catalog order decides, so a deployment pins its own preference with the `prefer` config. */
const PREFER_DEFAULT = ["-vl", "vl-", "vision", "qvq"];

/**
 * `provider` + `model` pin one route to try first (empty = pure discovery).
 * `prefer` ranks discovered candidates by provider/model substrings.
 * `probeUndeclared` additionally tries routes whose catalog does not declare
 * image input — off by default, because a text-only route silently receives
 * per-image text placeholders instead of pixels.
 * `timeoutMs` budgets one candidate; `totalTimeoutMs` budgets the whole call.
 */
const Config = z.object({
	provider: z.string().default(""),
	model: z.string().default(""),
	prefer: z.array(z.string()).default(PREFER_DEFAULT),
	probeUndeclared: z.boolean().default(false),
	maxCandidates: z.number().step(1).min(1).max(12).default(6),
	maxTokens: z.number().step(1).min(64).max(131072).default(4096),
	timeoutMs: z.number().step(1).min(1000).max(600000).default(60000),
	totalTimeoutMs: z.number().step(1).min(2000).max(600000).default(150000),
	maxImages: z.number().step(1).min(1).max(8).default(4)
});

const IMAGE_EXTENSIONS = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};

/** Discovery is re-read on topology change and at worst once per minute. */
const DISCOVERY_TTL_MS = 60_000;
/** A route that refused an image stays refused for a while. */
const REFUSAL_TTL_MS = 600_000;

/** Minimal magic-byte sniffing so extension-less files still work. */
function sniffImageMediaType(data) {
	if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	if (data.length >= 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
	if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
	return undefined;
}

const SYSTEM_PROMPT = [
	"You are a precise visual analysis engine embedded in a coding agent.",
	"Answer the caller's question about the attached image(s) with concrete, verifiable detail: names, counts, colors, text transcription (OCR with layout), positions (top/bottom/left/right, approximate pixel coordinates where useful), and differences between images when asked to compare.",
	"Report only what is visibly present. If something is unclear or absent, say so explicitly instead of guessing.",
	"If you were not actually given any image — for example the attachment arrived as a text placeholder — say exactly that instead of inventing a description.",
	"Answer in the same language the question uses. Be concise and structured; no preamble."
].join("\n");

/** Combine the execution signal with a wall-clock budget. */
function callSignal(exec, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout]);
}

/** Select the route's least supported reasoning effort: vision Q&A needs speed. */
function leastReasoning(controls, model) {
	const effort = model.reasoning?.efforts?.[0]?.id;
	return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
}

function terminalFinish(finish) {
	switch (finish.kind) {
		case "stop":
		case "max-tokens":
			return finish;
		case "tool-calls":
			throw new Error("dsh-vision-flash: vision model returned tool calls, which this call does not support");
		case "error":
		case "aborted": {
			const error = new Error(finish.failure.message);
			error.code = finish.failure.code;
			error.status = finish.failure.status;
			throw error;
		}
		default:
			throw new Error(`dsh-vision-flash: unexpected stream finish kind "${finish.kind}"`);
	}
}

/**
 * Classify one candidate failure so the loop can decide what it means. Quota
 * and rate limits are transient and provider-wide, so they only demote a
 * route; an explicit refusal to accept image content is a capability verdict.
 */
function classifyFailure(error) {
	const code = String(error?.code ?? "").toUpperCase();
	const text = `${code} ${error?.message ?? ""}`.toLowerCase();
	if (code === "QUOTA" || code === "RATE_LIMIT" || /quota|limit exhausted|too many requests|429/.test(text)) return "quota";
	if (code === "AUTH" || code === "MISSING_CREDENTIAL" || code === "INVALID_CREDENTIAL" || code === "NO_ADAPTER") return "unusable";
	if (/image|vision|modalit|multimodal/.test(text) && /not support|unsupported|does not|invalid|cannot|unable|only text|text-only|placeholder/.test(text)) return "no-image";
	return "error";
}

function shortReason(error) {
	const message = String(error?.message ?? error ?? "unknown error").split("\n")[0].trim();
	const code = error?.code ? `${String(error.code).toLowerCase()}: ` : "";
	return `${code}${message}`.slice(0, 180);
}

function apply(ctx, config) {
	// `??` guards keep the plugin mounted even if the harness hands us a raw
	// config that skipped the schema defaults.
	const resolved = {
		provider: (config.provider ?? "").trim(),
		model: (config.model ?? "").trim(),
		prefer: (config.prefer ?? PREFER_DEFAULT).map((pattern) => String(pattern).toLowerCase()),
		probeUndeclared: config.probeUndeclared ?? false,
		maxCandidates: config.maxCandidates ?? 6,
		maxTokens: config.maxTokens ?? 4096,
		timeoutMs: config.timeoutMs ?? 60000,
		totalTimeoutMs: config.totalTimeoutMs ?? 150000,
		maxImages: config.maxImages ?? 4
	};

	/** Discovered candidates and per-route capability verdicts, both invalidated on topology change. */
	let cache;
	const verdicts = new Map();
	const invalidate = () => { cache = undefined; };
	ctx.on("llm/adapters-updated", invalidate);
	ctx.on("llm/models-updated", invalidate);

	const routeKey = (candidate) => `${candidate.provider}/${candidate.model}`;

	/** Every registered route that the harness can prove accepts image input. */
	async function discover() {
		const now = Date.now();
		if (cache && now - cache.at < DISCOVERY_TTL_MS) return cache.candidates;
		const found = [];
		for (const provider of ctx.llm.listProviders()) {
			let models;
			try {
				models = await ctx.llm.listModels(provider.id);
			} catch {
				continue;
			}
			for (const model of models) {
				const declared = Array.isArray(model.inputModalities) && model.inputModalities.includes("image");
				if (!declared && !resolved.probeUndeclared) continue;
				found.push({ provider: provider.id, model: model.id, declared });
			}
		}
		const explicit = resolved.provider.length > 0 && resolved.model.length > 0
			? [{ provider: resolved.provider, model: resolved.model, declared: true, explicit: true }]
			: [];
		const rank = (candidate) => {
			if (candidate.explicit) return -1;
			const text = routeKey(candidate).toLowerCase();
			const index = resolved.prefer.findIndex((pattern) => pattern.length > 0 && text.includes(pattern));
			return (index === -1 ? resolved.prefer.length : index) + (candidate.declared ? 0 : 1000);
		};
		const seen = new Set(explicit.map(routeKey));
		const candidates = [...explicit, ...found.filter((candidate) => {
			if (seen.has(routeKey(candidate))) return false;
			seen.add(routeKey(candidate));
			return true;
		})].sort((a, b) => rank(a) - rank(b));
		cache = { at: now, candidates };
		return candidates;
	}

	/** Forget capability verdicts that have grown stale. */
	function pruneVerdicts(now) {
		for (const [route, verdict] of verdicts) {
			if (now - verdict.at > REFUSAL_TTL_MS) verdicts.delete(route);
		}
	}

	ctx.tools.register(defineTool({
		name: "vision_analyze",
		description: "Analyze image file(s) with the best vision-capable model route the harness currently has (auto-discovered across every configured provider, with fall-through when one route is exhausted) and return its findings as text. Use this automatically whenever an image must be understood, described, compared, verified, or OCR'd — the main model is text-only and cannot see pixels. Supports PNG/JPEG/WebP/GIF from the workspace or absolute paths. Pass `route` as \"provider/model\" to force one specific model.",
		parameters: {
			paths: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "One to a few image file paths to analyze (relative resolve from the workspace root; absolute paths accepted)."
			},
			question: {
				type: "string",
				required: true,
				description: "What to look for and report, in any language. Ask for exactly the evidence needed (description, OCR text, differences, quality issues, coordinates)."
			},
			route: {
				type: "string",
				description: "Optional \"provider/model\" override for this single call — use it when the caller knows which endpoint should see the image."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					model: { type: "string", required: true, description: "Provider route and model that produced the answer." },
					answer: { type: "string", required: true, description: "Vision model findings as plain text." },
					attempted: {
						type: "array",
						required: true,
						description: "Every candidate route tried in order, with its outcome.",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								route: { type: "string", required: true },
								outcome: { type: "string", required: true, description: "used | quota | unusable | no-image | timeout | error | skipped-refusal" },
								reason: { type: "string" }
							}
						}
					},
					images: {
						type: "array",
						required: true,
						description: "Images that were analyzed.",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string" },
								name: { type: "string" },
								width: { type: "integer" },
								height: { type: "integer" },
								bytes: { type: "integer" }
							}
						}
					}
				}
			},
			render: (_args, value) => [{ type: "text", text: value.answer }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const question = args.question.trim();
			if (question.length === 0) throw new Error("vision_analyze: question must be a non-empty string");
			const requested = [...new Set(args.paths.map((item) => item.trim()).filter((item) => item.length > 0))];
			if (requested.length === 0) throw new Error("vision_analyze: at least one image path is required");
			if (requested.length > resolved.maxImages) throw new Error(`vision_analyze: at most ${resolved.maxImages} images per call, got ${requested.length}`);

			const total = callSignal(exec, resolved.totalTimeoutMs);
			const attachments = ctx.get("attachments");
			const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
			const content = [];
			const analyzed = [];
			for (const rawPath of requested) {
				const target = await ctx.fs.resolve(rawPath, { signal: total });
				const data = await ctx.fs.readBytes(target, total, byteCap);
				const declared = IMAGE_EXTENSIONS[extname(rawPath).toLowerCase()];
				const mediaType = declared ?? sniffImageMediaType(data);
				if (mediaType === undefined) throw new Error(`vision_analyze: cannot read "${rawPath}": not a supported PNG/JPEG/WebP/GIF image`);
				if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`vision_analyze: cannot read "${rawPath}": ${mediaType} images are not accepted by this deployment`);
				let ref;
				try {
					ref = await attachments.saveImage({ data, mediaType, name: basename(rawPath) });
				} catch (error) {
					if (error instanceof AttachmentError && (error.code === "IMAGE_DIMENSION_TOO_LARGE" || error.code === "IMAGE_TOO_MANY_PIXELS" || error.code === "IMAGE_TOO_LARGE")) {
						throw new Error(`vision_analyze: cannot read "${rawPath}": the image exceeds the deployment's size limits; downscale it and retry`, { cause: error });
					}
					if (error instanceof AttachmentError && error.code === "IMAGE_TYPE_MISMATCH") {
						throw new Error(`vision_analyze: cannot read "${rawPath}": the file extension declares ${mediaType}, but the bytes use a different image format`, { cause: error });
					}
					throw error;
				}
				content.push({ type: "image", attachment: ref });
				analyzed.push({
					path: ctx.fs.processPath(target),
					name: ref.name ?? basename(rawPath),
					width: ref.width,
					height: ref.height,
					bytes: ref.bytes
				});
			}
			content.push({ type: "text", text: question });
			const message = { role: "user", content };

			const now = Date.now();
			pruneVerdicts(now);
			let queue;
			if (typeof args.route === "string" && args.route.includes("/")) {
				const [provider, ...rest] = args.route.split("/");
				queue = [{ provider, model: rest.join("/"), declared: true, forced: true }];
			} else {
				queue = (await discover()).slice(0, resolved.maxCandidates);
			}
			if (queue.length === 0) {
				throw new Error([
					"vision_analyze: no vision-capable model route is discoverable right now.",
					"Declare image input on one route that can actually see, e.g. in cordis.patch.yml for the pi-ai provider:",
					"  - id: <model id>  /  input: [text, image]",
					"or pin this plugin's `provider` + `model` config, or pass `route`. Registered providers: " +
					ctx.llm.listProviders().map((provider) => provider.id).join(", ")
				].join(" "));
			}

			const attempted = [];
			let lastFailure;
			for (const candidate of queue) {
				const route = routeKey(candidate);
				if (!candidate.forced && verdicts.has(route)) {
					attempted.push({ route, outcome: "skipped-refusal", reason: verdicts.get(route).reason });
					continue;
				}
				const perCall = AbortSignal.any([total, AbortSignal.timeout(resolved.timeoutMs)]);
				try {
					const call = await ctx.llm.prepareCall(
						{ provider: candidate.provider, model: candidate.model, maxTokens: resolved.maxTokens },
						perCall,
						leastReasoning
					);
					const options = { ...call.config, messages: [message], system: SYSTEM_PROMPT, signal: perCall };
					const assembler = new BlockAssembler();
					for await (const chunk of call.stream(options)) {
						perCall.throwIfAborted();
						assembler.push(chunk);
					}
					perCall.throwIfAborted();
					const finish = terminalFinish(assembler.finish);
					const answer = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
					if (answer.length === 0) throw new Error("the vision model produced no text answer");
					attempted.push({ route, outcome: "used" });
					return {
						model: route,
						answer: finish.kind === "max-tokens" ? `${answer}\n[answer truncated at maxTokens ${resolved.maxTokens}]` : answer,
						attempted,
						images: analyzed
					};
				} catch (error) {
					if (total.aborted) {
						attempted.push({ route, outcome: "timeout", reason: `whole-call budget of ${resolved.totalTimeoutMs} ms exhausted` });
						lastFailure = error;
						break;
					}
					const kind = perCall.aborted ? "timeout" : classifyFailure(error);
					attempted.push({ route, outcome: kind, reason: perCall.aborted ? `no answer within ${resolved.timeoutMs} ms` : shortReason(error) });
					if (kind === "no-image") verdicts.set(route, { at: Date.now(), reason: shortReason(error) });
					lastFailure = error;
				}
			}

			const tried = attempted.map((item) => `${item.route} → ${item.outcome}${item.reason ? ` (${item.reason})` : ""}`).join("; ");
			const skipped = attempted.filter((item) => item.outcome === "skipped-refusal").length;
			const hint = total.aborted
				? `The whole-call budget of ${resolved.totalTimeoutMs} ms ran out before any route answered.`
				: attempted.some((item) => item.outcome === "quota")
					? "Every candidate route reported quota or rate limiting."
					: skipped === attempted.length
						? `Every candidate route is on image-refusal cooldown after: ${tried}. Retry shortly or pass \`route\` to force one.`
						: "No candidate route could answer this image.";
			const last = lastFailure === undefined ? "" : ` Last failure: ${shortReason(lastFailure)}.`;
			throw new Error(`vision_analyze: ${hint} Tried ${tried}.${last} Set the plugin's provider/model config, pass \`route\`, or declare \`input: [text, image]\` on a vision-capable model.`);
		},
		presentCall(args) {
			const pinned = args.route ?? (resolved.provider.length > 0 && resolved.model.length > 0 ? `${resolved.provider}/${resolved.model}` : undefined);
			return {
				card: "generic",
				title: `Analyze ${args.paths?.length ?? 1} image(s) with ${pinned ?? "the best available vision model"}`,
				kind: "read",
				locations: (args.paths ?? []).map((path) => ({ path }))
			};
		}
	}));
}

export { Config, apply, inject, name };
