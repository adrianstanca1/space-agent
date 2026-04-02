# AGENTS

## Purpose

`app/` is the primary Space Agent runtime.

Keep agent orchestration, prompt construction, tool flow, state management, user interaction, and optimistic UX in the browser whenever possible. Server-backed work in this tree should be browser clients for explicit server APIs, not server-side orchestration leaking into the frontend.

Documentation is top priority for this area. After any change under `app/` or any app-facing contract change owned here, update this file in the same session before finishing.

## Structure

The browser runtime is organized into three layers:

- `L0/`: immutable firmware changed through updates
- `L1/`: runtime-editable group customware
- `L2/`: runtime-editable user customware

Current browser entry surfaces are served from `server/pages/`:

- `/`: main chat shell from `server/pages/index.html`
- `/admin`: admin shell from `server/pages/admin.html`
- `/login`: standalone login screen from `server/pages/login.html`
- `/logout`: server-side logout action that clears the session cookie and redirects to `/login`

Current shared module locations:

- `app/L0/_all/mod/_core/framework/`: shared frontend framework bootstrap, runtime helpers, API client, modal/component support
- `app/L0/_all/mod/_core/chat/`: current chat runtime, UI, storage, execution context, and LLM client helpers
- `app/L0/_all/mod/_core/admin/`: current admin UI modules
- `app/L0/test/`: firmware-side test and example customware fixtures
- frontend JS extension hook files live under each module's `ext/` folder and resolve by module-relative extension-point path, for example `mod/_core/framework/ext/_core/framework/initializer.js/initialize/start/...`
- page-level HTML extensions follow the same pattern; for example the main `/` shell exposes `html/body/start`, and the core chat runtime attaches there through `/mod/_core/chat/ext/html/body/start/chat-page.html`
- page-specific shells may expose their own anchors when they should not share a generic page hook; for example the admin shell uses `page/admin/body/start` and the core admin UI attaches there through `/mod/_core/admin/ext/page/admin/body/start/admin-shell.html`

## Layer Rules And Module Model

- `L0` is firmware and should stay update-driven
- `L1` contains per-group customware; `_all` and `_admin` are special groups
- `L2` contains per-user customware; users should only write inside their own `L2/<username>/`
- `L1` and `L2` are transient runtime state and are gitignored; do not document repo-owned example content there as if it were durable framework structure
- `app/L2/<username>/user.yaml` stores user metadata such as `full_name`; auth state lives under `app/L2/<username>/meta/`
- groups may include users and other groups, and may declare managers that can write to that group's `L1` area
- group definitions live in `group.yaml` files under `app/L0/<group-id>/` and `app/L1/<group-id>/`
- read permission rules are explicit: users can read their own `L2/<username>/`, and can read `L0/<group>/` and `L1/<group>/` only for groups they belong to
- write permission rules are explicit: users can write their own `L2/<username>/`; users can write `L1/<group>/` only for groups they manage directly or through managing-group inclusion; `_admin` members can write any `L1/` and `L2/` path; nobody writes `L0/`
- modules are the supported browser extension unit
- each group or user owns a `mod/` folder, and module contents are namespaced as `mod/<author>/<repo>/...`
- browser-facing code and assets should normally be delivered through `/mod/...`
- the current inheritance model is `L0 -> L1 -> L2` across the effective group chain for the current user
- authenticated frontend fetches now rely on the server-issued session cookie after login; do not reintroduce client-trusted identity shortcuts

## Frontend Implementation Guide

- keep root HTML shells thin and static; session gating for root pages belongs in the server router, not in inline boot scripts
- keep page shells under `server/pages/` minimal; they should mount app modules rather than duplicating frontend logic there
- keep pre-auth shell-only art or binary assets under `server/pages/res/` and load them from `/pages/res/...` instead of embedding large data blobs directly into page HTML
- use `app/L0/_all/mod/_core/framework/colors.css` as the shared palette source for authenticated frontend surfaces; prefer its semantic purpose-based tokens over hardcoded page-local colors
- use `app/L0/_all/mod/_core/framework/visual.css`, loaded through `index.css`, for shared backdrop primitives such as the space canvas and sparse celestial motion instead of rebuilding page backgrounds from scratch
- use `/mod/_core/framework/initFw.js` as the shared frontend bootstrap for framework-backed pages
- treat the extension system as the root composition primitive for the frontend runtime: `initFw.js` imports `/mod/_core/framework/extensions.js` first, that module initializes `globalThis.space`, and later framework modules build the runtime tree by exposing and extending module-scoped extension points
- import `/mod/_core/framework/extensions.js` only once from `initFw.js`; later modules should use `globalThis.space.extend(...)` directly and should not create local `const extend = ...` aliases just to forward the same global
- use `space.extend(import.meta, fn)` for extensible functions; when a function represents an object-style or class-style branch in the runtime tree, pass an explicit relative extension-point name such as `space.extend(import.meta, "Initializer/setDeviceClass", fn)`
- prefer Alpine stores created with `createStore(...)` for feature controllers
- gate store-dependent component content with `x-data` and `template x-if="$store.<name>"`
- use Alpine handlers such as `@click`, `@submit.prevent`, `@input`, `@keydown`, `x-model`, `x-text`, `x-ref`, `x-init`, and `x-destroy` instead of wiring most behavior through manual `querySelector` listeners
- pass DOM references into stores from Alpine via `x-ref`; do not make stores scan the whole document when direct refs will do
- keep stores responsible for state, persistence, async flows, and orchestration; move large render-only helpers into separate modules when templating alone becomes too dense
- expose shared browser-facing APIs through the `space` runtime namespace
- keep feature-specific runtime state in the owning feature namespace or store, such as `space.currentChat`, not in generic runtime globals
- keep new runtime features in module folders, not in ad hoc top-level static paths
- legacy extension helpers still exist under the framework area; do not expand them casually if the module-based `/mod/...` model already covers the use case
- wrapped functions expose their resolved extension point at `fn.extensionPoint`; use that in the browser console when debugging where matching extension files belong
- cache empty extension lookups as valid results; a missing extension point should not trigger repeated `/api/extensions_load` polling during the same cache lifetime
- uncached extension lookups are batched to one `/api/extensions_load` request per frame; keep extension discovery bursty and declarative so the batcher can collapse multiple JS and HTML hook lookups together during bootstrap and DOM scans

## Visual Guidance

Space Agent frontend work should look like one deliberate system rather than a mix of unrelated component-library defaults.

- minimal first: solve hierarchy with spacing, alignment, type scale, and one strong surface before adding extra panels, dividers, chips, or decorative UI
- dark space environment: use the semantic color tokens from `app/L0/_all/mod/_core/framework/colors.css` by purpose and use the shared space backdrop from `app/L0/_all/mod/_core/framework/visual.css`; do not invent page-local background systems when the shared one fits
- paused light mode: light mode is paused for new frontend work, and the old light aliases in `colors.css` are migration compatibility only, not a design target
- public shell mirroring: public shells that cannot load authenticated `/mod/...` assets, such as `/login`, should mirror the same semantic token names and backdrop recipe locally so they stay aligned with the shared design system
- restrained atmosphere: keep the space direction calm and intentional, with deep navy canvases, subtle starfield texture, and soft accent glow rather than noisy sci-fi chrome or neon overload
- restrained motion: if motion is used, keep it sparse, atmospheric, and easy to ignore; it should support the mood without turning the interface into an attention trap
- usable contrast: body text, controls, focus states, and status states must remain clear and comfortable for long sessions; do not trade readability for mood
- soft geometry: use a 4 px spacing rhythm, keep controls compact, prefer 14 to 16 px radii for inputs and buttons, and 22 to 28 px radii for major panels and shells
- compact mobile layouts: mobile screens should reduce padding, collapse secondary decoration, and preserve clear tap targets without turning the layout into stacked oversized cards
- reusable promotion rule: when a style pattern appears in more than one place, move it into shared framework CSS instead of cloning slightly different local versions

## Current State

- `server/pages/index.html` and `server/pages/admin.html` are plain module-backed shells; the server router decides whether to serve them or redirect to `/login`
- `server/pages/index.html` now exposes the `html/body/start` extension anchor and the core chat shell is injected there from `/mod/_core/chat/ext/html/body/start/chat-page.html` rather than being hardcoded directly in the page shell
- `server/pages/admin.html` now exposes the `page/admin/body/start` extension anchor and the core admin shell is injected there from `/mod/_core/admin/ext/page/admin/body/start/admin-shell.html`
- `server/pages/login.html` contains the login submit flow inline, can create a temporary guest account through `/api/guest_create`, reuses the primary username and password fields to present guest credentials before continuing, exchanges credentials for a server session before redirecting to `/`, and is the current reference implementation of the minimal dark space visual draft, including the two-column intro with the continuously drifting astronaut mascot
- `/login` is public and should not depend on authenticated `/mod/...` assets; when it needs theme tokens or the shared space backdrop before login, mirror the shared semantic palette and backdrop recipe locally instead of inventing a separate visual system
- `/logout` is handled entirely by the server pages layer; there is no standalone logout page shell in `app/` or `server/pages/`
- browser-side file changes still require a manual browser refresh; live reload is not wired into the app runtime yet
- `app/L0/_all/mod/_core/framework/visual.css` now owns the shared space canvas backdrop primitives used across frontend surfaces
- the current frontend runtime tree starts at `/mod/_core/framework/initFw.js`, installs `space.extend` from `/mod/_core/framework/extensions.js`, runs extensible framework bootstrap functions such as `/mod/_core/framework/initializer.js`, and then continues composing further runtime behavior by module and extension point
- when app structure, layer behavior, module layout, entry shells, or frontend conventions change, update this file in the same session
