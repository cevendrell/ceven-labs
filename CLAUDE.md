# Claude Code Instructions

## Working directory
Always edit files directly in this repository — never use a worktree or subdirectory.
The repo root is the working directory for all edits.

## Site structure
Static HTML site. No build step — edits to `.html` files are the final output.
- `index.html` — homepage (Ceven Labs company landing page)
- `pages/layovr/` — LayOvr app marketing page
- `pages/flowen/` — Flowen app marketing page (contraction timer for labor)
- `pages/solutions/` — solutions overview; `pages/solutions/bike-fit/` — Bike Fit web tool
- `pages/about/` — About Ceven Labs (company info, CVR, founder)
- `pages/support/` — Support & FAQ (Apple App Store support URL)
- `pages/legal/` — privacy-policy.html, terms.html (required for Apple App Store; cover ALL apps and web tools, not just one)

## Footer convention
All pages use the same slim footer (`.footer-slim`): "© year Ceven Labs · CVR: 46571975 · Built by Carlos Ebrahim Vendrell" plus Privacy Policy / Terms of Use / Support links. Keep this consistent when adding pages.

## Company facts
Ceven Labs is a Danish sole proprietorship (CVR 46571975) based in Aarhus, Denmark — never call it a "private limited company" or ApS. Mention only "Aarhus" as location (not Risskov). Owner has unlimited personal liability, so legal pages must keep strong disclaimers, limitation of liability, and indemnification covering every app and tool.

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
