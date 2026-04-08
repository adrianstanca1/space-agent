# Hugging Face Browser Runtime

This doc covers the first-party browser inference test surface under `_core/huggingface`.

## Primary Sources

- `app/L0/_all/mod/_core/huggingface/AGENTS.md`
- `app/L0/_all/mod/_core/huggingface/view.html`
- `app/L0/_all/mod/_core/huggingface/store.js`
- `app/L0/_all/mod/_core/huggingface/huggingface-worker.js`
- `app/L0/_all/mod/_core/huggingface/helpers.js`
- `app/L0/_all/mod/_core/huggingface/transformers.js`

## Route

The route is:

```txt
#/huggingface
```

The router resolves that to:

```txt
/mod/_core/huggingface/view.html
```

The route is browser-only. It does not add backend API endpoints or server-owned model state.

## What The Page Does

`_core/huggingface` is a compact proof-of-concept test harness for browser inference with Hugging Face Transformers.js on WebGPU.

The page owns:

- a current-model panel with ready/loading/error state
- one freeform model loader that accepts a Hugging Face repo id or Hub URL
- a small saved-model list remembered in browser storage for quick reuse
- a collapsed advanced section for dtype and max-new-token settings
- a simple testing chat with system prompt, user messages, streamed assistant replies, stop, and clear-chat
- compact response metrics inline under each assistant reply

This is not a general agent surface. It does not expose tool execution, queueing, attachments, persisted conversations, or backend orchestration.

## Worker Split

`_core/huggingface` keeps the heavy inference runtime out of the routed page thread.

The ownership split is:

- `view.html` mounts the route shell and binds to the Alpine store
- `store.js` owns UI state, local persistence, saved-model memory, worker lifecycle, and streamed message updates
- `huggingface-worker.js` owns the Transformers.js import, model downloads, generation, streaming, and interruption
- `protocol.js` holds the stable message names between the page and the worker
- `transformers.js` pins the external browser import so the worker references one local module path instead of embedding the CDN URL inline

The store may terminate and recreate the worker to stop an in-flight model download or to unload the currently loaded model. That keeps the runtime route-local and disposable.

## Model Loading

Users load one model at a time by entering either:

- a plain Hugging Face repo id such as `org/model`
- a Hub URL such as `https://huggingface.co/org/model`

The helper layer normalizes Hub URLs back to repo ids before the worker loads them.

The worker uses Transformers.js browser APIs on `device: "webgpu"`. The route keeps the current stable browser pin in `transformers.js`; as of April 8, 2026, the official docs page labels `main` as source-install-only and points normal npm/browser installs at stable `v3.8.1`, so this route pins that stable browser import instead of an unpinned preview build.

Important model constraint:

- this route is for Transformers.js-compatible text-generation repos
- in practice that means repos with the needed ONNX/browser assets available to Transformers.js
- the route does not try to discover or validate all compatible repos ahead of time
- instead, the UI points users to the ONNX Community models browser on Hugging Face

Saved models in the sidebar are just route-owned browser storage entries for quick reuse. They are not a browser-cache inventory and should not be treated as authoritative cache state.

## Downloads And Caching

Transformers.js itself owns browser-side downloads and caching. `_core/huggingface` only forwards progress reports and load results into the route UI.

Current behavior:

- first load downloads tokenizer and model assets in the browser
- later loads may reuse whatever the browser-side Transformers.js cache already retained
- the route does not expose cache scanning or cache deletion because Transformers.js does not expose the same model-catalog and cache-management surface that WebLLM does in `_core/webllm`
- the current-model panel shows the active asset or phase under the progress bar, with the best available bytes-transferred or percent detail appended, because the underlying progress callback reports multiple per-file steps rather than one stable global download percentage

## Chat Flow

The chat flow is intentionally minimal:

1. the store builds a plain message list from the system prompt plus prior user/assistant turns
2. the worker prepares either a chat-template input or a plain fallback prompt when the tokenizer lacks a usable chat template
3. generation streams partial text back into the current assistant message
4. stop uses a worker-owned stopping-criteria gate so generation can end cleanly with `finishReason: "abort"`
5. when generation ends, the worker sends the final text plus measured metrics

The route does not keep any worker-side chat history. Every request is rebuilt from the current message list owned by the page store.

## Metrics

Assistant turns include one compact inline metadata row under the response.

Current metrics are:

- model id
- `t/s`: derived tokens per second
- `t/min`: derived tokens per minute
- `p/c`: prompt tokens / completion tokens
- `ttft`: time to first streamed text
- `e2e`: end-to-end latency

These metrics are measured locally from the prepared prompt, generated output ids, and timing data inside the worker. There is no server-side accounting layer here.

## Related Docs

- `app/runtime-and-layers.md`
- `app/modules-and-extensions.md`
- `app/webllm-browser-runtime.md`
