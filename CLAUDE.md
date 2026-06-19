# Claude Code Instructions

## Working directory
Always edit files directly in this repository — never use a worktree or subdirectory.
The repo root is the working directory for all edits.

## Site structure
Static HTML site. No build step — edits to `.html` files are the final output.
- `index.html` — homepage (Ceven Labs company landing page)
- `pages/layovr/` — LayOvr app marketing page
- `pages/about/` — About Ceven Labs
- `pages/support/` — Support & FAQ (Apple App Store support URL)
- `pages/legal/` — privacy-policy.html, terms.html (required for Apple App Store)

## Navigation
All pages share the same `<nav id="navbar">` structure.
Inner pages (inside `pages/*/`) use relative paths: `../../index.html` for home.

## PLACEHOLDER convention
Strings marked `PLACEHOLDER` (in caps) need to be filled in before launch:
- `PLACEHOLDER-DOMAIN` — the actual domain (e.g. cevenlabs.com)
- `PLACEHOLDER-CVR` — Danish company registration number
- `PLACEHOLDER-SUPPORT-EMAIL` — support email address
- `PLACEHOLDER — App Store` — App Store link (not yet published)
- `PLACEHOLDER — App screenshots` — actual app screenshots

## Apple App Store requirements
These pages are specifically required for App Store Connect:
- **Privacy Policy URL**: `pages/legal/privacy-policy.html`
- **Support URL**: `pages/support/index.html`
- **Marketing URL**: `pages/layovr/index.html`

## Design tokens
Color palette (shared across all pages):
- `--bg: #06080f` (dark background)
- `--bg-alt: #080d1a` (dark navy)
- `--accent: #c9a86a` (teak/acacia — LayOvr brand color)
- `--brand: #4a90e8` (Ceven Labs blue)
- `--text: #ededea`

Fonts: Inter (UI), JetBrains Mono (monospaced labels/eyebrows)

## Workflow
User pushes via GitHub Desktop → GitHub Pages auto-deploys.
