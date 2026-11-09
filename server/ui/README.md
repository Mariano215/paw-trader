# Trader Dashboard UI (sliced)

This directory contains the dashboard UI code for Paw Trader, sliced out of
ClaudePaw's single-page dashboard (`server/public/app.js` + `style.css` +
`index.html`).

**Phase 1 status (today):** these files are a code mirror. They are not
runnable standalone because they call into helpers defined in the parent
`app.js` (routing, fetch wrappers, page navigation, etc.).

**Phase 3 status (roadmap):** the trader dashboard becomes a proper module
loaded via a ClaudePaw plugin `registerDashboardPage()` hook.

Files:

- `trader-dashboard.js` — main trader page logic + scattered init/routing
  snippets extracted from `app.js`
- `trader-dashboard.css` — trader-specific styles
- `trader-sidebar.html` — the sidebar navigation entry

See the top-level `docs/ROADMAP.md` for the extraction plan.
