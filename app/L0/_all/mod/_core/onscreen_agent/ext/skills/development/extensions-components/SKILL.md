---
name: Extensions And Components
description: Use HTML adapters, JS hook seams, and component loading correctly in the layered module system.
---

Use this skill when the task needs `ext/html/`, `ext/js/`, `x-extension`, `x-component`, or layered override behavior.

## HTML Extension Rules

- Declare structural seams with `<x-extension id="some/path">`.
- Matching HTML files live at `mod/<author>/<repo>/ext/html/some/path/*.html`.
- HTML callers name only the seam; the runtime resolves `ext/html/` automatically.
- Keep extension files thin. They should usually mount a real component with `<x-component path="/mod/...">`.

Example:

```html
<x-extension id="page/router/overlay/end"></x-extension>
```

```html
<x-component path="/mod/_core/onscreen_agent/panel.html"></x-component>
```

## JS Hook Rules

- Use `space.extend(import.meta, async function name(...) { ... })` for behavioral seams.
- JS hook files live at `mod/<author>/<repo>/ext/js/<extension-point>/*.js` or `*.mjs`.
- The runtime resolves `/start` and `/end` hooks around the wrapped function automatically.
- `space.extend()` requires a valid module ref and a standalone named function or explicit extension point name.
- Framework-backed pages expose `_core/framework/initializer.js/initialize`; prefer its `/end` hook for once-per-page shell setup such as analytics or `document.head` injection.
- If a feature needs onscreen-agent-specific prompt shaping or execution validation for its own helpers, add an `ext/js/_core/onscreen_agent/...` hook from that feature instead of editing `_core/onscreen_agent` directly.

## Component Loader Rules

- `<x-component>` may load a full HTML document or a fragment.
- The loader mounts styles, module scripts, and body nodes, then recursively resolves nested `<x-component>` tags.
- Keep component HTML declarative and bind behavior through stores.
- Import the owning store module in the component that owns the feature, not in an unrelated parent shell.

## Layered Override Behavior

- Module and extension resolution follow the readable `L0 -> L1 -> L2` inheritance chain.
- Identical module-relative extension file paths override lower-ranked entries.
- Different filenames under the same extension point compose together.
- Prefer additive composition before exact-path replacement.
- `maxLayer` constrains module and extension resolution but not logical app-file paths.
- Uncached HTML `<x-extension>` lookups batch before they call `/api/extensions_load`; the default flush is the next animation frame, and frontend constant `HTML_EXTENSIONS_LOAD_BATCH_WAIT_MS` in `app/L0/_all/mod/_core/framework/js/extensions.js` adds an extra wait window in milliseconds before that frame-aligned flush.
- JS hook lookups do not use that wait window; they resolve immediately because hook callers await them directly.

## Practical Guidance

- Add a new seam in the owner when downstream customization is realistic.
- Do not bypass an existing seam by reaching into another module's private DOM or internals.
- After adding a new `ext/html/...` or `ext/js/...` file, the running page often needs a refresh before discovery catches up.

## Mandatory Doc Follow-Up

- If extension lookup, component loading, hook behavior, or override semantics change, update the framework docs and the `development` skill subtree in the same session.
