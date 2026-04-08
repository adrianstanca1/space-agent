# Modules And Extensions

This doc covers how browser code is delivered and composed.

## Primary Sources

- `app/AGENTS.md`
- `app/L0/_all/mod/_core/framework/AGENTS.md`
- `app/L0/_all/mod/_core/router/AGENTS.md`
- `server/lib/customware/AGENTS.md`
- `server/api/AGENTS.md`

## Module Paths

Browser modules are namespaced as:

```txt
mod/<author>/<repo>/...
```

Examples:

- `/mod/_core/framework/js/initFw.js`
- `/mod/_core/router/view.html`
- `/mod/_core/documentation/documentation.js`
- `/mod/_core/huggingface/view.html`
- `/mod/_core/webllm/view.html`

The backend resolves those requests through layered customware inheritance, so the same `/mod/...` URL may be backed by `L0`, `L1`, or `L2`.

## Router Path Resolution

The authenticated router is hash-based.

Important route rules:

- `#/dashboard` -> `/mod/_core/dashboard/view.html`
- `#/huggingface` -> `/mod/_core/huggingface/view.html`
- `#/webllm` -> `/mod/_core/webllm/view.html`
- `#/author/repo/path` -> `/mod/author/repo/path/view.html`
- if the last route segment already ends in `.html`, the router resolves directly to that file under `/mod/...`

The main router helper surface is published on `space.router` and Alpine `$router`.

## HTML Extension Anchors

HTML extension seams use:

```html
<x-extension id="some/path"></x-extension>
```

Resolution rules:

- the caller names only the seam
- matching files live under `mod/<author>/<repo>/ext/html/some/path/*.html`
- extension files should stay thin and normally mount the real component or view

Important shared router seams include:

- `_core/router/shell_start`
- `_core/router/shell_end`
- `page/router/route/start`
- `page/router/route/end`
- `page/router/overlay/start`
- `page/router/overlay/end`

## JavaScript Extension Hooks

Behavior seams use `space.extend(import.meta, async function name() {})`.

Rules:

- the wrapped function becomes async
- hooks resolve under `mod/<author>/<repo>/ext/js/<extension-point>/*.js` or `*.mjs`
- wrapped functions expose `/start` and `/end` hook points
- framework-backed page boot exposes `_core/framework/initializer.js/initialize`; its `/end` hook is the normal place for once-per-page integrations such as analytics bootstrap or `document.head` tag setup
- feature-specific prompt or execution behavior for the onscreen agent should be supplied from the owning module through `_core/onscreen_agent/...` extension seams, not hardcoded into `_core/onscreen_agent`

Uncached HTML `<x-extension>` lookups are grouped before they hit `/api/extensions_load`:

- by default the frontend flushes the lookup queue on the next animation frame
- frontend constant `HTML_EXTENSIONS_LOAD_BATCH_WAIT_MS` in `app/L0/_all/mod/_core/framework/js/extensions.js` adds an extra wait window in milliseconds before that frame-aligned flush
- when a frame does not arrive, the frontend falls back to a short timeout so the queue still drains

JS hook lookups do not use that frame wait window. Hook callers await them directly, so the frontend requests JS extension paths immediately instead of delaying them for batching.

## `<x-component>`

The component loader accepts both full HTML documents and fragments.

Behavior:

- styles and stylesheets are appended to the mount target
- module scripts are loaded via dynamic `import()`
- nested `<x-component>` tags are loaded recursively
- wrapper attributes are exposed to descendants through `xAttrs($el)`

The normal ownership split is:

- component HTML owns structure and Alpine bindings
- store modules own state and async work
- helper modules own dense transforms or protocol logic

## Route-Local Workers

Heavy browser-only runtimes do not have to become global framework dependencies.

Current first-party example:

- `_core/huggingface` keeps its worker, local import shim, and the Transformers.js browser runtime contract inside one route-local module
- `_core/webllm` keeps the vendored WebLLM browser build and its dedicated worker inside the module
- the routed page imports only its local store and talks to the worker through a small module-local protocol file
- this is the preferred pattern for experimental routed test surfaces that need a large browser runtime but do not yet justify promotion into `_core/framework`

## Shared Visual Primitives

Reusable modal structure lives under `_core/visual`, not inside each feature.

Important dialog rules:

- `app/L0/_all/mod/_core/visual/forms/dialog.css` owns the shared modal shell classes for fixed header/footer chrome
- use `dialog-card-shell` plus `dialog-scroll-body` or `dialog-scroll-frame` when a modal has long content and persistent footer actions
- use `dialog-actions-split` and related dialog action helpers for compact split footers instead of feature-local inline flex layout
- do not put overflow on the full dialog card when the footer must stay reachable; scroll only the inner body or framed content region

## Override Rules

Module and extension resolution follow the same layered model:

- exact same override keys replace lower-ranked entries
- different filenames under the same extension point compose together
- `maxLayer` limits module and extension lookup but not ordinary app-file APIs

This is why modules such as `documentation` and `skillset` can expose ordinary JS helpers that skills import through stable `/mod/...` URLs.
