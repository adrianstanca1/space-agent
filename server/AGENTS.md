# AGENTS

## Purpose

`server/` is the thin local infrastructure runtime.

It should not become the main application runtime. Keep browser concerns in `app/` and keep this tree focused on explicit infrastructure contracts that the browser or CLI needs.

Documentation is top priority for this area. After any change under `server/` or any server contract change owned here, update this file in the same session before finishing.

## Responsibilities

- serve the root HTML entry shells and public page-shell assets from `server/pages/`
- resolve browser-delivered modules from the layered `app/L0`, `app/L1`, and `app/L2` customware model
- expose server API modules from `server/api/`
- provide the outbound fetch proxy at `/api/proxy`
- support local development and source-checkout update flows without turning the server into business-logic orchestration

## Structure

Current server layout:

- `server/app.js`: server factory and subsystem bootstrap
- `server/server.js`: startup entry used by the CLI and thin host flows
- `server/config.js`: default host, port, and filesystem roots
- `server/dev_server.js`: source-checkout dev supervisor used by `npm run dev`
- `server/package.json`: ES module package boundary for the backend
- `server/pages/`: root HTML shell files served at `/`, `/login`, and `/admin`, plus public page-shell assets under `server/pages/res/` served from `/pages/res/...`
- `server/api/`: endpoint modules loaded by endpoint name, with multiword routes named object-first such as `login_check`, `guest_create`, and `extensions_load`
- `server/router/router.js`: top-level request routing order and API dispatch
- `server/router/pages_handler.js`: page-route handler for page auth gating, redirects, and page actions such as `/logout`
- `server/router/mod_handler.js`: `/mod/...` static module resolution and file serving
- `server/router/request_context.js`: AsyncLocalStorage-backed request context and authenticated user resolution
- `server/router/request_body.js`: low-level request body parsing helpers
- `server/router/cors.js`: API CORS policy and preflight handling
- `server/router/responses.js`: shared response writers for JSON, redirects, file responses, and API result serialization
- `server/router/proxy.js`: outbound fetch proxy transport used by `/api/proxy`
- `server/lib/api/registry.js`: API module discovery
- `server/lib/auth/`: password verifier, login session, user file, and auth service helpers
- `server/lib/utils/`: shared low-level utilities such as app-path normalization and lightweight YAML helpers
- `server/lib/customware/`: layout parsing, group index building, and module inheritance resolution
- `server/lib/customware/file_access.js`: reusable normalized app-path permission checks plus index-backed `file_read`, `file_write`, `file_list`, and pattern-based `file_paths` helper operations
- `server/lib/file_watch/config.yaml`: declarative watched-file handler configuration
- `server/lib/file_watch/handlers/`: watchdog handler classes such as `path_index`, `group_index`, and `user_index`, loaded by name from config
- `server/lib/file_watch/watchdog.js`: reusable filesystem watchdog that dispatches matching change events to handlers and exposes handler indexes
- `server/lib/git/`: backend-abstracted Git clients used by the `update` command

## Request Flow And Runtime Contracts

- request routing order is: API preflight handling, `/api/proxy`, `/api/<endpoint>`, `/mod/...`, then pages as the last fallback
- non-`/mod` and non-`/api` requests stay limited to root HTML shells and page actions owned by the pages layer
- the router-side pages handler owns page auth gating and page-route actions: unauthenticated requests for protected pages redirect to `/login`, authenticated requests to `/login` redirect to `/`, and `/logout` clears the current session then redirects to `/login`
- public page-shell assets under `/pages/res/...` are served directly from `server/pages/res/` without authentication so pre-auth shells such as `/login` can load shell-local artwork
- `/mod/...` requests resolve through the layered customware model, using the watched `path_index` plus the group index to select the best accessible match from `L0`, `L1`, and `L2`
- request identity is now derived from the server-issued `space_session` cookie via the router-side `request_context` helper and the watched `user_index`
- `app/L2/<username>/user.yaml` stores user metadata such as `full_name`; auth state lives under `app/L2/<username>/meta/`, where `password.json` stores the password verifier and `logins.json` stores active session codes
- only explicit public endpoints such as login status, login challenge, login completion, and health may run without authentication; other APIs and `/mod/...` fetches must require a valid session
- root page shells are pretty-routed as `/`, `/login`, and `/admin`; legacy `.html` requests redirect to those routes
- page-shell assets keep their explicit `/pages/res/...` paths and are not pretty-routed
- app filesystem APIs use app-rooted paths like `L2/alice/user.yaml` or `/app/L2/alice/user.yaml`
- read permissions are: own `L2/<username>/`, plus `L0/<group>/` and `L1/<group>/` for groups the user belongs to
- write permissions are: own `L2/<username>/`; managed `L1/<group>/`; `_admin` members may write any `L1/` and `L2/`; nobody writes `L0/`
- watchdog infrastructure is config-driven
- `path_index` is a normal watchdog handler, not a special side channel
- `path_index` is the canonical fast lookup for existing app files and directories and is the basis for server-side path resolution and app-file listing
- `group_index` derives group membership and management relationships from `group.yaml`
- `group_index` is the canonical permission graph for group-owned app paths and should back reusable read/write/list permission decisions instead of endpoint-local logic
- `user_index` derives L2 user metadata, password verifier, and session state from `user.yaml`, `meta/password.json`, and `meta/logins.json`
- `user_index` is the canonical derived auth/session view; request identity should come from it and then flow into shared `file_access` helpers as the current username
- add new watchdog handlers by adding handler classes and wiring them in `server/lib/file_watch/config.yaml`, not by manually binding handlers in `server/app.js`

## Index-Backed App File Access

- `server/lib/customware/file_access.js` is the canonical shared entry point for authenticated app file access and path listing used by API endpoints or other server-side agent-facing flows
- `listAppPaths()` is the required implementation path for `file_list`-style behavior; it resolves existing targets from `path_index`, applies readable-scope checks with the authenticated username plus `group_index`, and returns deterministic sorted app-rooted paths
- `listAppPathsByPatterns()` is the required implementation path for `file_paths`-style hierarchy lookups; it scans `path_index` through the authenticated user's readable `L0 -> L1 -> L2` owner roots, matches owner-relative glob patterns, and returns full app-relative paths grouped by the requested pattern strings
- `readAppFile()` and `writeAppFile()` share the same normalization and permission model; when a new endpoint needs app-file reads or writes, extend these helpers centrally instead of duplicating path parsing or access rules inside the endpoint
- do not add ad hoc filesystem walks for app path discovery in API handlers when `path_index` can answer the question; keep file-list operations index-backed so agent-oriented listing stays efficient as the tree grows
- do not derive group or user access state inside each endpoint; request identity comes from the router/auth flow backed by `user_index`, and reusable access decisions should combine that username with `group_index`
- after writes that can affect file existence, group membership, or user/session/auth state, refresh the watchdog so `path_index`, `group_index`, and `user_index` stay synchronized with disk
- if `file_access` rules, index inputs, or watcher coverage change, update `server/lib/file_watch/config.yaml`, the affected shared helpers, and this document in the same session

## API Module Contract

Endpoint files are named by route:

- `/api/health` loads `server/api/health.js`
- `/api/file_read` loads `server/api/file_read.js`

Multiword API route names should use object-first underscore naming so related endpoints stay grouped together alphabetically, for example `login_check`, `guest_create`, and `extensions_load`.

Endpoint modules may export method handlers such as:

- `get(context)`
- `post(context)`
- `put(context)`
- `patch(context)`
- `delete(context)`
- `head(context)`
- `options(context)`

Handler context may include parsed body data, query parameters, headers, request and response objects, `requestUrl`, `user`, app/server directory references, and watched-file indexes.

Handlers may return:

- plain JavaScript values, which are serialized as JSON automatically
- explicit HTTP-style response objects when status, headers, binary bodies, or streaming behavior matter
- Web `Response` objects for advanced cases

Current endpoint set:

- `db`
- `extensions_load`
- `file_list`
- `file_paths`
- `file_read`
- `file_write`
- `guest_create`
- `health`
- `login`
- `login_challenge`
- `login_check`

Current status notes:

- `db` is a placeholder route family for future persistence work
- `guest_create`, `login`, `login_challenge`, and `login_check` are the current public auth-related endpoints
- `login` enforces a 500 ms minimum response time on both success and failure so authentication outcome is not reflected as an immediate timing difference
- `guest_create` creates a temporary L2 guest user with generated credentials, refreshes the watchdog indexes, and leaves the actual login step to the normal frontend login flow, which now reuses the primary login fields to display those credentials before continuing
- `file_read`, `file_write`, and `file_list` are the current authenticated app-filesystem APIs; they operate on app-rooted paths through the shared `file_access` library, use watchdog-backed indexes for path resolution and permission decisions, and should remain the reusable contract for agent-oriented file access
- `file_paths` is the authenticated hierarchy-pattern lookup API; it matches owner-relative glob patterns such as `skills/SKILL.md` across the user's readable `L0`, `L1`, and `L2` roots and returns matched full paths relative to `/app`, while preserving hierarchy order and allowing directory patterns that end with `/`
- the current page shells live in `server/pages/`, while all page-serving logic stays in `server/router/pages_handler.js`
- public shell artwork or other shell-local binaries should live under `server/pages/res/` and load through `/pages/res/...` rather than being inlined into large data URIs in HTML; the login intro mascot in the two-column hero is the current reference example
- page shells under `server/pages/` should stay minimal and expose stable extension anchors when the frontend runtime should compose content dynamically; do not hardwire module components there when the `mod/**/ext/**` loader can own the composition instead
- public page shells such as `/login` should not depend on authenticated `/mod/...` assets; when they need design tokens or the shared space backdrop before login, mirror the semantic names from `app/L0/_all/mod/_core/framework/colors.css` and the same shared backdrop recipe from `app/L0/_all/mod/_core/framework/visual.css` locally and keep them aligned with `/app/AGENTS.md`
- `extensions_load` resolves extension files from layered `mod/**/ext/**` paths using the current user's group inheritance and exact module-path overrides
- `extensions_load` also accepts grouped request batches so the frontend can debounce uncached extension discovery to one request per frame while the server resolves all requested pattern groups in one inheritance pass

## Server Implementation Guide

- keep endpoints narrow and explicit
- keep multiword API endpoint filenames object-first so related routes stay grouped together alphabetically
- prefer plain JavaScript return values for simple JSON APIs
- use explicit response objects only when needed
- keep shared server libraries infrastructure-focused and reusable
- keep proxy transport, API hosting, file watching, and persistence concerns separate from app orchestration
- keep `server/app.js` focused on bootstrapping core subsystems, not on special-case registration logic
- keep `server/pages/` limited to static page assets and keep routing logic in `server/router/`
- keep app-path permission checks in shared server libraries, not duplicated inside each file API endpoint
- keep app-file listing and path discovery in shared index-backed helpers, not in endpoint-local filesystem scans
- treat `path_index`, `group_index`, and `user_index` as maintained infrastructure contracts; optimize and extend them centrally rather than bypassing them for one-off features
- use underscores consistently for multiword server-side module files, handler ids, and helper entry points; do not introduce new dash-separated names under `server/`
- keep file-list results deterministic, permission-aware, and efficient for agent use by preferring index lookups over repeated disk traversal
- prefer deterministic loader folders and name-based discovery for APIs, watched-file handlers, workers, and similar extension points
- keep inheritance resolution explicit and small
- keep new persistence APIs explicit, small, and integrity-safe
- do not move browser-side agent logic onto the server by default
- keep backend modules in `server/` on ES module syntax with `import` and `export`
- when server responsibilities, request flow, API contracts, watched-file behavior, or persistence architecture change, update this file in the same session
