/**
 * Offline self-test for the vision route auto-detection in `index.js`.
 *
 * A fake LLM seam advertises several providers with different declared
 * modalities and scripted outcomes, so the candidate ordering, the quota
 * fall-through, the capability verdicts and the topology invalidation are all
 * verified without any provider traffic:
 *
 *   node selftest.mjs        (run from this bundle directory)
 */
import { apply, Config, name } from "./index.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** The shipped defaults, read straight from the schema so the test never drifts. */
const DEFAULTS = Config({});

const attachments = {
	imageLimits: {
		maxImageBytes: 10_000_000,
		maxMessageImageBytes: 10_000_000,
		mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"]
	},
	saveImage: async ({ data, mediaType, name: file }) => ({ name: file, mediaType, width: 10, height: 10, bytes: data.length })
};

const textChunks = (answer) => [
	{ type: "block-start", index: 0, blockType: "text" },
	{ type: "text-delta", index: 0, text: answer },
	{ type: "block-end", index: 0, block: { type: "text", text: answer } },
	{ type: "usage", usage: { input: 1, output: 1, total: 2 } },
	{ type: "finish", reason: { kind: "stop" } }
];

const failureChunks = (message, code) => [
	{ type: "finish", reason: { kind: "error", failure: { message, code } } }
];

/** Mount the plugin against one mutable fake topology and capture its tool. */
function mount(config, topology) {
	const state = { calls: [], events: {}, tool: undefined };
	const ctx = {
		on(event, listener) {
			(state.events[event] ??= []).push(listener);
		},
		get: () => attachments,
		tools: { register: (definition) => { state.tool = definition; } },
		fs: { resolve: async (path) => path, readBytes: async () => PNG, processPath: (path) => path },
		llm: {
			listProviders: () => topology.providers.map((id) => ({ id, name: id })),
			listModels: async (provider) => (topology.models[provider] ?? []).map((model) => ({ provider, ...model })),
			prepareCall: async (callConfig) => {
				const route = `${callConfig.provider}/${callConfig.model}`;
				state.calls.push(route);
				const chunks = topology.behavior[route] ?? failureChunks(`no scripted behavior for ${route}`, "ERROR");
				return {
					config: { ...callConfig },
					stream: async function* () {
						for (const chunk of chunks) yield chunk;
					}
				};
			}
		}
	};
	apply(ctx, Config({ ...DEFAULTS, ...config }));
	return state;
}

const args = { paths: ["shot.png"], question: "Что изображено?" };
let failures = 0;
const assert = (label, condition, detail) => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  →  ${detail}` : ""}`);
};

// A) ranking: a route that declares image input wins over a preferred-but-burned one.
{
	const state = mount({}, {
		providers: ["zai", "deepseek", "qwencloud"],
		models: {
			zai: [
				{ id: "glm-5.3-flash", name: "glm-5.3-flash", inputModalities: ["text", "image"] },
				{ id: "glm-5.3", name: "glm-5.3", inputModalities: ["text"] }
			],
			deepseek: [{ id: "glm-5.3", name: "glm-5.3", inputModalities: ["text", "image"] }],
			qwencloud: [
				{ id: "auto", name: "auto", inputModalities: ["text"] },
				{ id: "qwen3.7-plus", name: "qwen3.7-plus", inputModalities: ["text"] },
				{ id: "qwen3-vl-8b", name: "qwen3-vl-8b", inputModalities: ["text", "image"] }
			]
		},
		behavior: {
			"qwencloud/qwen3-vl-8b": textChunks("Видимо, это скриншот отчёта."),
			"zai/glm-5.3-flash": failureChunks("Weekly/Monthly Limit Exhausted", "QUOTA"),
			"deepseek/glm-5.3": textChunks("unused fallback answer")
		}
	});
	const result = await state.tool.execute(args, {});
	assert("A1 a route answered", typeof result.answer === "string" && result.answer.length > 0, result.model);
	assert("A2 the -vl candidate is preferred over 'flash'", result.model === "qwencloud/qwen3-vl-8b", state.calls.join(" , "));
	assert("A3 text-only routes were never offered", !state.calls.includes("qwencloud/auto") && !state.calls.includes("zai/glm-5.3"), state.calls.join(" , "));
}

// B) an explicit provider/model pin goes first, then discovery falls through.
{
	const state = mount({ provider: "zai", model: "glm-5.3-flash" }, {
		providers: ["zai", "qwencloud"],
		models: {
			zai: [{ id: "glm-5.3-flash", name: "glm-5.3-flash", inputModalities: ["text", "image"] }],
			qwencloud: [{ id: "qwen3-vl-8b", name: "qwen3-vl-8b", inputModalities: ["text", "image"] }]
		},
		behavior: {
			"zai/glm-5.3-flash": failureChunks("limit exhausted", "QUOTA"),
			"qwencloud/qwen3-vl-8b": textChunks("second route answered")
		}
	});
	const result = await state.tool.execute(args, {});
	assert("B1 pinned route tried first", state.calls[0] === "zai/glm-5.3-flash", state.calls.join(" , "));
	assert("B2 fell through to the other vision route", result.model === "qwencloud/qwen3-vl-8b", result.model);
}

// C) nothing declares image input: an actionable error, never a placeholder call.
{
	const state = mount({}, {
		providers: ["qwencloud"],
		models: { qwencloud: [{ id: "auto", name: "auto", inputModalities: ["text"] }] },
		behavior: { "qwencloud/auto": textChunks("SHOULD NOT BE CALLED") }
	});
	let error;
	try {
		await state.tool.execute(args, {});
	} catch (caught) {
		error = caught;
	}
	assert("C1 refuses when no vision route is declared", /no vision-capable model route/.test(error?.message ?? ""), error?.message);
	assert("C2 the text-only route was not called", state.calls.length === 0, state.calls.join(" , "));
	assert("C3 the fix is spelled out with the provider names", /input: \[text, image\]/.test(error?.message ?? "") && /qwencloud/.test(error?.message ?? ""), error?.message);
}

// D) every candidate burned its quota: say so, per route.
{
	const state = mount({}, {
		providers: ["zai", "deepseek"],
		models: {
			zai: [{ id: "glm-5.3-flash", name: "glm-5.3-flash", inputModalities: ["text", "image"] }],
			deepseek: [{ id: "glm-5.3", name: "glm-5.3", inputModalities: ["text", "image"] }]
		},
		behavior: {
			"zai/glm-5.3-flash": failureChunks("429 Weekly/Monthly Limit Exhausted", "QUOTA"),
			"deepseek/glm-5.3": failureChunks("429 too many requests", "RATE_LIMIT")
		}
	});
	let error;
	try {
		await state.tool.execute(args, {});
	} catch (caught) {
		error = caught;
	}
	assert("D1 quota summary", /quota or rate limiting/.test(error?.message ?? ""), error?.message);
	assert("D2 both routes and both verdicts listed", /zai\/glm-5.3-flash → quota/.test(error?.message ?? "") && /deepseek\/glm-5.3 → quota/.test(error?.message ?? ""), error?.message);
}

// E) a route that refuses image content is remembered and skipped afterwards.
{
	const topology = {
		providers: ["mistral"],
		models: { mistral: [{ id: "m-vision", name: "m-vision", inputModalities: ["text", "image"] }] },
		behavior: { "mistral/m-vision": failureChunks("The model does not support image input", "BAD_REQUEST") }
	};
	const state = mount({ probeUndeclared: true }, topology);
	let first;
	try {
		await state.tool.execute({ ...args, route: "mistral/m-vision" }, {});
	} catch (error) {
		first = error;
	}
	assert("E1 refusal classified as no-image", /no-image/.test(first?.message ?? ""), first?.message);
	let second;
	try {
		await state.tool.execute(args, {});
	} catch (error) {
		second = error;
	}
	assert("E2 the refused route is not retried", state.calls.length === 1, `calls: ${state.calls.join(" , ")}`);
	assert("E3 the skip is reported", /skipped-refusal/.test(second?.message ?? ""), second?.message);
}

// F) a provider registered mid-session is picked up after the topology event.
{
	const topology = {
		providers: ["zai"],
		models: { zai: [{ id: "glm-5.3-flash", name: "glm-5.3-flash", inputModalities: ["text", "image"] }] },
		behavior: {
			"zai/glm-5.3-flash": failureChunks("limit exhausted", "QUOTA"),
			"newprovider/nv-vl": textChunks("answer from a provider added mid-session")
		}
	};
	const state = mount({}, topology);
	await state.tool.execute(args, {}).catch(() => {});
	assert("F1 original route tried", state.calls.join() === "zai/glm-5.3-flash", state.calls.join());
	topology.providers.push("newprovider");
	topology.models.newprovider = [{ id: "nv-vl", name: "nv-vl", inputModalities: ["text", "image"] }];
	for (const listener of state.events["llm/adapters-updated"]) listener();
	const result = await state.tool.execute(args, {});
	assert("F2 the new vision route is used", result.model === "newprovider/nv-vl", `${state.calls.join(" , ")} → ${result.model}`);
}

// G) one call may force an exact route, even one discovery would not offer.
{
	const state = mount({}, {
		providers: ["qwencloud"],
		models: { qwencloud: [{ id: "auto", name: "auto", inputModalities: ["text"] }] },
		behavior: { "qwencloud/auto": textChunks("auto can see after all") }
	});
	const result = await state.tool.execute({ ...args, route: "qwencloud/auto" }, {});
	assert("G1 forced route used", result.model === "qwencloud/auto" && state.calls.join() === "qwencloud/auto", result.model);
	assert("G2 answer text carried", result.answer === "auto can see after all", result.answer);
	assert("G3 image metadata reported", result.images.length === 1 && result.images[0].bytes > 0, JSON.stringify(result.images));
}

console.log(`${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}  (${name})`);
if (failures > 0) process.exitCode = 1;
