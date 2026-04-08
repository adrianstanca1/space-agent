# Admin Agent Runtime

This doc covers the firmware-backed admin agent surface under `_core/admin/views/agent/`.

Primary sources:

- `app/L0/_all/mod/_core/admin/AGENTS.md`
- `app/L0/_all/mod/_core/admin/views/agent/AGENTS.md`
- `app/L0/_all/mod/_core/admin/views/agent/store.js`
- `app/L0/_all/mod/_core/admin/views/agent/api.js`
- `app/L0/_all/mod/_core/admin/views/agent/webllm.js`
- `app/L0/_all/mod/_core/admin/views/agent/panel.html`

## Scope

The admin agent is a standalone admin-only chat surface mounted inside `/admin`.

It owns:

- its own settings and history persistence under `~/conf/admin-chat.yaml` and `~/hist/admin-chat.json`
- its own prompt assembly, history compaction, execution loop, and attachment runtime
- its own LLM transport switch between remote API streaming and browser-local WebLLM streaming

It does not depend on `_core/onscreen_agent` internals.

## Provider Model

The admin settings modal now starts with a provider switch:

- `LLM APIs`: the existing endpoint, model, API key, params, and max-token settings
- `Local WebLLM`: a browser-local path that uses WebGPU and a dedicated worker-backed runtime

The stored config keeps both API settings and the selected local provider state:

- `llm_provider`
- `webllm_model`
- the existing API fields and optional custom system prompt

Switching providers does not fork the rest of the admin agent loop. The admin surface still keeps one shared flow for:

- runtime prompt building
- history compaction
- retry-on-empty handling after execution follow-ups
- browser execution blocks
- streaming into the thread view

Only the final LLM transport call branches.

## Local WebLLM Path

The admin agent does not import the vendored WebLLM runtime on the main thread.

Instead:

- `views/agent/webllm.js` is the admin-local bridge
- that bridge talks to `/mod/_core/webllm/webllm-worker.js`
- the worker still owns model loading, cache scans, progress updates, interruption, unload, and chat streaming

The admin modal only exposes already-downloaded prebuilt models from the current browser cache. It shows:

- a selector of downloaded models
- current local model status
- loading progress while a model is being enabled
- a button that opens `/#/webllm` in a new tab so the user can download or test models there

This means the admin agent reuses the browser cache and worker protocol from `_core/webllm`, but keeps all admin state and branching local to `_core/admin/views/agent/`.

## Practical Behavior

- if `llm_provider` is `api`, admin chat uses the existing fetch-based streaming path
- if `llm_provider` is `webllm`, admin chat ensures the selected downloaded model is loaded locally before streaming
- stop requests still use the same admin stop flow; for WebLLM that abort signal is translated into worker-side `interruptGenerate()` or load-stop behavior
- history compaction uses the selected provider too, so local mode stays fully local once configured
