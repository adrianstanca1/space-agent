# Spaces And Widgets

This doc covers the spaces runtime because it is one of the most important agent-facing feature areas.

## Primary Sources

- `app/L0/_all/mod/_core/spaces/AGENTS.md`
- `app/L0/_all/mod/_core/spaces/onboarding/empty-canvas.css`
- `app/L0/_all/mod/_core/spaces/onboarding/empty-canvas.js`
- `app/L0/_all/mod/_core/spaces/onboarding/empty-canvas-examples.yaml`
- `app/L0/_all/mod/_core/spaces/onboarding/empty-canvas-examples.js`
- `app/L0/_all/mod/_core/spaces/onboarding/empty-canvas-example-helpers.js`
- `app/L0/_all/mod/_core/spaces/onboarding/examples/`
- `app/L0/_all/mod/_core/spaces/onboarding/first-login-onboarding.js`
- `app/L0/_all/mod/_core/spaces/ext/skills/spaces/SKILL.md`
- `app/L0/_all/mod/_core/spaces/storage.js`
- `app/L0/_all/mod/_core/spaces/store.js`

## Storage Layout

Spaces persist under the authenticated user's `~/spaces/<spaceId>/` root.

Important files:

- `space.yaml`: manifest, metadata, layout, minimized widgets, and timestamps
- `widgets/<widgetId>.yaml`: widget metadata plus the renderer source string
- `data/`: widget-owned structured files
- `assets/`: widget-owned assets fetched through `/~/...`

Important rules:

- new spaces start empty
- on first login, `_core/spaces` uses the shared `_core/login_hooks/first_login` seam to copy or reuse the bundled `_core/spaces/onboarding/onboarding_space/` template, whose `space.yaml` owns the `Big Bang` title, icon, color, and onboarding instructions, then on the main `/` shell rewrites the initial route so the router lands in that space instead of the default dashboard
- on the dashboard, `_core/spaces` now exposes the same create flow through both the spaces launcher and the always-available `New Space` topbar action injected through `_core/dashboard/topbar_primary`, so either entry point creates an empty space and opens it as a new route history entry
- while the spaces page is mounted with a current space, `view.html` exports a hidden `space:open` skill-context tag
- widget ids come from widget filenames
- the manifest should not invent fake untitled titles
- widget source is now YAML-first; old `widgets/*.js` files are migration input only
- space title and agent-instruction edits are draft-first in the current-space header popover and should flush on blur, panel close, route change, or unmount rather than persisting on every keystroke
- while a current space is open, `_core/spaces` defines its Back, title-toggle, Rearrange, and icon-only clear-all-widgets controls directly inside the spaces route and teleports them into the menu shell's existing `[id="_core/onscreen_menu/bar_start"]` container instead of rendering a separate fixed in-canvas overlay

## Runtime Namespaces

`_core/spaces` publishes:

- `space.current`: helpers for the currently open space
- `space.spaces`: helpers for cross-space CRUD and lower-level operations

Frequently used `space.current` helpers:

- `listWidgets()`
- `readWidget(widgetIdOrName)`
- `seeWidget(widgetIdOrName, full?)`
- `patchWidget(widgetId, { ... })`
- `renderWidget({ id, name, cols, rows, renderer })`
- `reloadWidget(widgetId)`
- `removeWidget(...)`, `removeWidgets(...)`, `removeAllWidgets()`
- `rearrange()`, `repairLayout()`, `toggleWidgets(...)`

Frequently used `space.spaces` helpers:

- `listSpaces()`
- `createSpace(...)`
- `openSpace(spaceId, options?)`
- `duplicateSpace(...)`
- `removeSpace(...)`
- `upsertWidget(...)`
- `patchWidget(...)`
- `renderWidget(...)`

## Layout Packing

Rearrange and default new-widget placement share one first-fit packer.

Rules:

- scan cells left to right, then top to bottom
- skip occupied cells immediately
- at each free cell, place the largest remaining widget that physically fits within the viewport-width threshold
- do not skip an obvious free slot just to chase a more compact aspect ratio later
- center the packed result back onto the canvas after placement
- the routed canvas height should be measured from the live router stage and applied explicitly by the spaces store, so the widget grid does not collapse when shell-level bars above the route change height
- the viewport-sized spaces canvas should not clip its own grid; keep canvas overflow visible so camera-panned widgets can slide visually beneath the fixed routed header bar
- when the visible widget span is shorter than the viewport, give both camera axes real sparse-layout wiggle room instead of a locked midpoint; horizontal sparse content should still open visually centered but remain pannable left or right afterward, and vertical sparse mode should also take over whenever the normal content-fit clamp would leave only tiny travel on medium-height screens so a lone widget does not feel vertically locked; vertical sparse content should open slightly scrolled downward so first widgets sit higher, and falling back to the empty canvas should reset the camera before the next first-widget render

## Dashboard Launcher

The dashboard-facing spaces launcher keeps its cards visually fixed instead of using stretch-to-fill widths.

Rules:

- cards stay square at one shared size until the viewport is too narrow to hold that size
- when the current card count is still below the row capacity, that single row is centered within the launcher
- row capacity is based on fixed card size plus a required minimum horizontal gap, so narrow layouts drop columns before cards collide and full dashboard width can still host five cards when it truly fits
- once the launcher reaches the current row capacity, it uses one explicit left-to-right column stage with stretched parent slots while the cards inside those slots stay square
- wrapped remainder rows stay left-aligned and reuse the same horizontal spacing as the full row above them through that shared slot stage
- widget-name pills are capped to two visible rows inside each card
- the launcher still caps wide-screen rows at five cards

## Empty Space Canvas

When a space has no widgets yet, the routed canvas uses a staged onboarding sequence instead of one static placeholder.

Rules:

- keep the example-card placeholders above the text block for now, but keep them hidden until the final reveal
- keep the empty-space onboarding stack above the viewport midpoint with explicit top and bottom breathing room so the reserved example-button area stays higher and the CTA copy can still land below it without dropping into the onscreen-agent overlay zone
- keep the empty-space runtime under `_core/spaces/onboarding/`: `_core/spaces/onboarding/empty-canvas.js` owns the DOM and animation wiring, `_core/spaces/onboarding/empty-canvas.css` owns the empty-space and loading-canvas presentation, and the first-login bootstrap plus bundled onboarding space also live in that folder
- load the example buttons from `_core/spaces/onboarding/empty-canvas-examples.yaml` instead of a hardcoded prompt array; each entry supplies visible button text, icon, color, and a JavaScript click body compiled by `_core/spaces/onboarding/empty-canvas-examples.js`
- animate each onboarding text block independently instead of rewriting one existing sentence in place, and float each visible text independently so the copy does not move as one glued cluster
- phase 1 shows `Just an empty space here`
- phase 2 reveals a smaller `for now` with a visibly wider gap below the primary line and enough hold time to read both intro lines comfortably
- phase 3 reveals `Tell your agent what to create`
- phase 4 reveals a smaller `or try one of the examples above`
- phase 5 reveals the example buttons after the examples line is already visible
- keep the intro pair visible long enough to read after `for now` appears, but keep the overall text sequence about 25% faster than the previous pass while preserving readability, and keep a brief gap between the intro pair fading out and the replacement pair fading in so the new lines do not appear during the old lines' exit animation
- play the full staged sequence only once for each pristine newly created empty space; if that space is opened again later, or if an existing space becomes empty after its last widget is removed, render the final examples-visible state immediately instead of replaying the early steps
- make the copy block itself clickable so users can skip the staged sequence and jump directly to the fully revealed final state
- each YAML example body runs as ordinary async JavaScript inside a tiny ES module that imports `_core/spaces/onboarding/empty-canvas-example-helpers.js` as `helpers`, so example code can use normal browser-side JavaScript plus that helper module instead of a runtime-injected helper object
- prompt-style example actions should call `helpers.submitPrompt(...)`, which routes into `space.onscreenAgent.submitExamplePrompt(...)` so default API-key blockers surface `Don't forget to configure your LLM first.` and active streaming or execution surfaces `I'm working on something...` through the overlay bubble instead of silently queueing
- those onboarding YAML entries should also declare `kind`, and the empty-canvas renderer should use the global Alpine `onscreenAgent` store getters to fade only the `kind: chat` buttons while the overlay is inactive, without making them unclickable
- when one of those `kind: chat` buttons is clicked while the overlay store still reports an inactive state, the empty-canvas click handler should short-circuit before the YAML body runs and call `showExamplePromptInactiveBubble()` on the same global store so the blocker bubble still appears
- example actions that should create widgets directly should copy local widget YAML bundles from `_core/spaces/onboarding/examples/` through `helpers.installOnboardingExampleWidget(...)` for one-off widgets or `helpers.installOnboardingExampleWidgets(...)` for multi-widget presets instead of referencing `dashboard_welcome/examples/...` at runtime; the multi-widget helper should batch those copied widget YAML files into one storage write before it reloads the current space so every widget mount starts together
- when one of those onboarding widget bundles is copied from a first-party demo widget, keep the local snapshot under `_core/spaces/onboarding/examples/`; single-widget copies should still strip source-demo placement fields such as `col` or `row` so normal placement applies, but curated multi-widget presets that intentionally recreate a demo layout should preserve copied `col`, `row`, `cols`, and `rows` values
- those local onboarding copies may also rename demo-specific widget ids or names into cleaner generic ones when the copied widget is meant to stand alone in onboarding, so a generic weather card does not keep an `iphone-...` name after it leaves the demo bundle
- when one curated onboarding preset combines multiple related widgets, keep any small shared user-owned preference files aligned across those copied widgets so feed or location changes stay coherent inside that preset
- curated onboarding presets cloned from welcome examples may also keep paired widget surfaces together, so a copied YouTube list-and-player pair should stay local to one onboarding preset folder and keep its preserved layout there
- when a caller intentionally batches several onboarding widget writes into the current space, metadata saves may still use `refresh: false`, but the preset helper should persist the widget bundle through one storage-level batched write and then issue one final reload so widget renderers start together instead of waiting behind several sequential widget saves
- compact onboarding article-detail cards should prefer making the image and headline themselves open the article, and should avoid redundant header labels or separate open buttons when that vertical space is better spent on summary text; related compact news cards, including the Daily News top-headline widget, should also rely on the widget shell's built-in reload control instead of adding duplicate in-card refresh buttons
- if one of those onboarding widget bundles relies on YouTube embedding, prefer copying the proven `_core/dashboard_welcome/examples/agent-zero-videos/widgets/yt-video-player.yaml` loading pattern into the local onboarding copy and only swap the initial video id or feed source
- example button icon ligatures and accent colors should also come from that onboarding YAML so chat actions and bundled widget-clone actions can present different button chrome without hardcoded per-example styling in JS
- the same imported helper module also exposes direct runtime access through `helpers.getSpaceRuntime()`, `helpers.getSpacesRuntime()`, and `helpers.getOnscreenAgentRuntime()` for future non-prompt examples
- the one-time empty-space onboarding marker is client-owned browser UI state stored per user under `space.spaces.emptyCanvasSeen.<username>` with `sessionStorage` and `localStorage` mirrors; it is not part of persisted `space.yaml`
- reduced-motion users should not be forced through the staged animation; show the stable final copy and buttons immediately

## Widget Renderer Contract

Preferred renderer shape:

```js
async (parent, currentSpace) => {
  // render into parent
}
```

Rules:

- render directly into `parent`
- do not add outer wrapper padding just to inset content; the widget shell already provides that space
- the default widget card surface is `#101b2d` (`rgba(16, 27, 45, 0.92)`); avoid another generic full-card background unless the content needs a dedicated stage
- prefer light text and UI elements by default because widget content sits on a dark surface
- repo-owned YouTube iframe widgets should set `iframe.referrerPolicy = "strict-origin-when-cross-origin"` so embedded playback keeps the referrer YouTube now expects
- repo-owned YouTube widgets that need to react when playback ends should use the official IFrame API state-change events with `enablejsapi=1` and the current `origin`, and should use `ctx.widget.id` plus `ctx.space.id` for self-removal instead of hardcoded widget ids
- use `space.utils.markdown.render(text, parent)` for markdown-heavy content
- for remote HTTP data, use plain `fetch(...)` or `space.fetchExternal(...)`; do not hardcode third-party CORS proxy services in widget renderers because the runtime already falls back to `/api/proxy`
- do not import required widget scripts, styles, fonts, or other non-data runtime assets from external CDNs in repo-owned widgets or bundled demo spaces; vendor required assets locally or use system/browser-native assets so offline app rendering still works
- return a cleanup function when listeners, timers, or similar long-lived effects are attached
- widget size is capped at `24x24`
- choose only the footprint the widget needs

The framework owns the outer card and the responsive grid. Widgets own only their content.

## Agent Workflow

The spaces runtime is designed around staged turns.

Normal flow:

1. `listWidgets()` if the live catalog is unknown
2. `readWidget(...)` to load the latest numbered renderer readback
3. on the next turn, `patchWidget(...)` for bounded edits or `renderWidget(...)` for a rewrite
4. `reloadWidget(...)` or another read on a later turn if needed

Important protocol rules:

- `readWidget(...)` and `listWidgets()` are discovery steps
- the next dependent mutation should usually happen on the next turn, not in the same execution block
- `readWidget(...)` returns numbered renderer lines for patch targeting
- those numeric prefixes are display-only targets, not source text
- prompt-side readbacks land in `_____framework` or `_____transient`
- the first-party `spaces` skill is eligible only while the router exports `route:spaces`, and it becomes `just loaded` only while the page exports `space:open`

## When To Read More

- For the overlay execution protocol itself: `agent/prompt-and-execution.md`
- For file path and permission rules: `server/customware-layers-and-paths.md`
