# App Runtime And Layers

This doc covers the frontend boot flow, the browser runtime namespace, and the layered app model.

## Primary Sources

- `app/AGENTS.md`
- `app/L0/_all/mod/_core/framework/AGENTS.md`
- `app/L0/_all/mod/_core/router/AGENTS.md`
- `app/L0/_all/mod/_core/framework/js/runtime.js`
- `server/pages/*.html`

## Frontend Boot Flow

Authenticated app pages are served by the server shells, then booted by framework code:

1. `server/pages/index.html` or `server/pages/admin.html` loads shared framework assets.
2. `/mod/_core/framework/js/initFw.js` installs the frontend runtime.
3. The first mounted module takes over the next seam.
4. `_core/router` owns `/` and `_core/admin` owns `/admin`.

Important shell facts:

- `/admin` injects `meta[name="space-max-layer"]` with `0`, so module and extension resolution stay firmware-only
- page shells may inject `meta[name="space-config"]` values for runtime params marked `frontend_exposed`
- `/login` and `/enter` are special recovery-safe shells that do not depend on authenticated `/mod/...` assets

## Layer Model

The app is layered as:

- `L0`: repo-owned firmware
- `L1`: group customware
- `L2`: user customware

Logical paths stay stable even when the writable roots move:

- repo default: `app/L1/...` and `app/L2/...`
- relocated writable roots: `CUSTOMWARE_PATH/L1/...` and `CUSTOMWARE_PATH/L2/...`
- logical API paths still look like `L1/...`, `L2/...`, `/app/L1/...`, `/app/L2/...`, or `~/...`

Permission summary:

- nobody writes `L0`
- users write their own `L2/<username>/...`
- users write `L1/<group>/...` only if they manage that group
- `_admin` members may write any `L1` and `L2` path

## `globalThis.space`

Framework boot publishes the shared runtime on `globalThis.space`.

Important namespaces:

- `space.api`: authenticated backend API client helpers
- `space.config`: frontend-exposed runtime params
- `space.fw.createStore`: Alpine store helper
- `space.utils.markdown.render(...)` and `parseDocument(...)`
- `space.utils.yaml.parse(...)` and `stringify(...)`, backed by the shared project-owned lightweight YAML utility in `_core/framework/js/yaml-lite.js`, which server modules also import directly
- `space.proxy`, `space.download`, `space.fetchExternal(...)`
- `space.router`: router helper surface on routed app pages
- `space.onscreenAgent`: overlay display and prompt submission helpers
- `space.current` and `space.spaces`: spaces and widget helper surfaces
- `space.visual`: small shared UI helpers exposed by visual modules
- `space.chat`: current prepared chat context when an agent surface publishes it

The runtime is window-local. It must not be published into `parent`, `top`, or sibling frames.

## Identity And Writable Roots

Frontend code should derive writable roots from `space.api.userSelfInfo()`.

That helper returns:

```txt
{ username, fullName, groups, managedGroups }
```

Use it to decide whether a write belongs in:

- `~/...` or `L2/<username>/...`
- a managed `L1/<group>/...`
- a cross-user or admin-only path only when `_admin` access is explicitly available

## Related Docs

- `app/modules-and-extensions.md`
- `server/customware-layers-and-paths.md`
- `server/request-flow-and-pages.md`
