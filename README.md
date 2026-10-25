# dsh-vision-delegation

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) Web GUI plugin that lets a **text-only main model** work with pasted images through **vision delegation** — no model switching, no rejected messages.

## The problem

You run a strong text-only coding model (e.g. `glm-5.3`) as your main model. The moment you paste an image into the DSH Web GUI and hit send, the Host rejects the prompt:

> *"The current model does not support images; switch to a model that does"*

— and you have to switch to a multimodal model manually, ask your question, and switch back.

## The fix

This plugin converts every pasted/picked/dropped image into a generic **file attachment** at the composer boundary, in place, before it can ride the prompt as an image part (the only form the Host rejects for text-only models). The bytes and a meaningful filename (`image.png`, `screenshot.webp`, …) are preserved; only the carriage changes.

The main model then receives the harness's standard file handle:

```
[File "image.png" (84 213 bytes, sha256:ab12cd34): verbatim read-only copy saved at
"C:\…\.dsh\attachments\…". Read that path with your file tools when its contents
are needed; …]
```

… and stays fully in charge. It formulates **its own question** — casual or forensic, whatever the current request needs — and calls **its own vision tool** (e.g. `vision_analyze` backed by glm-5.3-flash, `read_image`, or any multimodal subagent) on the saved path. The vision tool answers as text, and the main model continues the workflow seamlessly. That is ordinary agentic delegation: the big model decides what the little model should look for.

### What you see

- Pasted images appear in the attachment rail as a **file chip** (with a brief upload) instead of a thumbnail.
- The model picker never moves. No switching, nothing to restore, no race with the send button.
- The transcript shows the vision tool call the main model makes.
- A small "👁 vision delegation" pill under the composer confirms the plugin is armed.

## Requirements

- DSH Web GUI (the plugin is a client-side bundle; it adds no Host services).
- Works with **any** main model — including natively multimodal ones (they can read the file path directly). It merely changes how images travel, not who looks at them.
- Pairs naturally with a vision tool such as a `vision_analyze`-style plugin (e.g. one backed by glm-5.3-flash), but requires nothing specific: the model receives a readable path and decides for itself what to do with it.

## Install

From a clone of this repository (adjust the path):

```
# in a DSH session with the plugin manager available, tell your agent:
"Install the bundle at D:\path\to\dsh-vision-delegation"
```

which uses the Harness `plugin_manager` (`install_bundle` with the package directory). Then **refresh the Web GUI page** once so the client bundle loads. The pill under the composer confirms activation.

To verify manually after install, the plugin row appears in **Settings → Plugins** as "Vision Delegation".

## Uninstall / disable

- Disable: toggle the "Vision Delegation" row off in **Settings → Plugins**, then refresh the page. Pasted images revert to plain image attachments.
- Remove: remove the bundle in **Settings → Plugins** (or ask your agent to `remove_bundle dsh-vision-delegation`).

## How it works (for DSH plugin developers)

The client half (`client.js`):

1. Subscribes to the active session's composer input store (`uiSession.adapter.current` → `hooks.input`) and the conversation draft registry (`conversation` service).
2. When an image draft lands (`resolveDraftAttachments` → `kind: 'image'`), it re-wraps the same `File` with a generic MIME (`application/octet-stream`, name preserved or timestamped), routes it through `conversation.createDrafts` — whose own classifier then selects the file-draft path with its background upload — attaches the new ids via the provide-channel `inputActions.addAttachments`, and releases the original image draft.
3. File attachments are admitted for every model (the `MODEL_DOES_NOT_SUPPORT_IMAGES` check only inspects image parts) and are rendered to the model as readable-path file handles by the Host (`fileHandleText` in `@deepseek-ai/dsh-llm`).

No slots are replaced, no shipped UI is shadowed; the only visible footprint is the armed pill registered in the `conversation.composer.dock` list slot.

## License

[MIT](LICENSE)
