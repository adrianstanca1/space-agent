# AGENTS

## Purpose

`_core/dashboard_welcome/` owns the dashboard-injected welcome surface.

It renders the dismissible welcome panel at the top of the dashboard, persists the user's hide or show preference under `~/conf/`, and ships first-party demo-space folders that can be cloned into the authenticated user's `~/spaces/` root.

Documentation is top priority for this module. After any change under `_core/dashboard_welcome/`, update this file and any affected parent docs in the same session.

## Ownership

This module owns:

- `dashboard-welcome.html`, `dashboard-welcome.js`, and `dashboard-welcome.css`: the injected welcome UI, shared hidden-state sync, and demo-space launch actions
- `dashboard-prefs.js`: shared dashboard preference loading, saving, and welcome-hidden sync events for dashboard-local surfaces
- `dashboard-topbar-toggle.html` and `dashboard-topbar-toggle.js`: the dashboard topbar restore button shown only while the welcome panel is hidden
- `ext/html/_core/dashboard/content_start/dashboard-welcome.html`: thin dashboard extension adapter for the welcome surface
- `ext/html/_core/dashboard/topbar_secondary/welcome-toggle.html`: thin dashboard topbar adapter for the hidden-state restore action
- `examples/`: the curated bundled example-space folders copied into the user's writable spaces area on demand; the current firmware bundle contains `examples/agent-zero-videos/`, `examples/arcade/`, and `examples/daily-dashboard/`

## Local Contracts

Current dashboard integration:

- `_core/dashboard/` provides the `_core/dashboard/content_start` and `_core/dashboard/topbar_secondary` seams
- this module injects the welcome panel through that seam and should remain above the spaces list
- when the welcome panel is hidden, the dashboard flow should collapse completely with no placeholder row, and the restore action should move into the dashboard's teleported topbar cluster instead
- the welcome surface should stay optional and user-dismissable without affecting the rest of the dashboard
- the dismiss control should be a compact circular icon button aligned to the panel edge within the dashboard gutter, with local sizing rules strong enough to override shared `secondary-button` chrome, and demo-card icons should read as oversized clipped background motifs at low opacity with a slight glassy blur and the glyph itself explicitly oversized, not as inline badges
- demo-card title, description, icon, and icon color should load from each bundled example's own `space.yaml` so the dashboard preview matches the installed space metadata instead of relying on separate hardcoded presentation values

Current persistence and demo-space contract:

- the hide or show preference is stored in `~/conf/dashboard.yaml`
- the only persisted setting currently owned here is whether the welcome panel is hidden
- `dashboard-prefs.js` should stay the only owner of the preference read/write and cross-surface hidden-state sync contract, so the dashboard panel and topbar restore button stay aligned without duplicating file logic
- bundled demo spaces live under this module's `examples/` folder and are copied through the spaces runtime instead of being edited in place
- `dashboard-welcome.js` should discover bundled examples at runtime through the `file_paths` pattern `mod/_core/dashboard_welcome/examples/*/space.yaml` instead of maintaining a hardcoded example list
- each bundled example folder should own its card metadata in `space.yaml`, including `title`, `description`, `icon`, and `icon_color`
- bundled example card copy should stay concise and polished: use clean title casing for titles and short sentence-case descriptions that read naturally in the welcome cards
- bundled demo widgets that fetch remote data should use runtime-managed `fetch(...)` or `space.fetchExternal(...)`; do not hardcode third-party CORS proxy services inside example widgets because the frontend runtime already falls back to `/api/proxy`
- bundled demo widgets must not import required scripts, styles, fonts, or other non-data runtime assets from external CDNs; vendor required assets locally or use system/browser-native assets so installing a demo space does not make framework rendering depend on the internet
- the Daily Dashboard example should keep its news column at `5x9` so it aligns with the stacked weather and crypto widgets, and its crypto widget should track Bitcoin, Ethereum, and Solana
- bundled demo `space.yaml` files should own the icon and color shown in the welcome cards, and installing a demo should preserve those values into the created user space
- welcome actions should call the public `space.spaces.installExampleSpace(...)` runtime helper rather than duplicating filesystem logic locally
- demo installs launched from the dashboard should push a new space route entry instead of replacing the dashboard route, so browser Back returns to the dashboard rather than exposing whatever older space happened to be behind it in history

## Development Guidance

- keep the copy brief, direct, and product-relevant
- keep the welcome surface visually lighter than the spaces grid below it
- keep hidden-state restore UI in the dashboard topbar, not in a placeholder dashboard row
- if the preference path, extension seam, or example-space loading contract changes, update this file and the owning parent docs
