# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The internal review page for the ZIPA POKER 2026 visual identity (Federation Standard 1A),
served by GitHub Pages at
https://zipapoker2025-netizen.github.io/zipa-poker-design-review/

`index.html` is a single self-contained document — every logo, QR code and reference image is
inlined as a data URI. No build step, no dependencies, no framework. Push and Pages redeploys.

Alongside it sits a per-section response system so colleagues can register 同意／有疑慮／先保留
plus a note before the review meeting, and a results page that turns those answers into an agenda.

## Regenerating index.html — read this first

`index.html` is authored elsewhere (the design system's cloud project) and copied in wholesale.
**Whatever regenerates it will not know about the two script tags this repo appends.** After any
overwrite, restore them immediately before `</body>`:

```html
<script src="review-config.js"></script>
<script src="review-vote.js"></script>
```

Without them the page still renders perfectly — it simply loses every voting control, silently.
Nothing errors, so this failure is easy to ship. Verify after any regeneration:

```bash
grep -c 'review-vote.js' index.html   # must be 1
```

The header paragraph also references the voting controls ("每一節下方都有…"). If a regenerated
`index.html` reverts that sentence to the old "有意見請直接留言" wording, update it too.

Note that `ZIPA POKER Design System/review/index.html` in the sibling repo is a **fragment** with no
`<head>` or `<body>` — it is not this file and must not receive the script tags.

## Section ids are derived, not declared

`review-vote.js` builds each section's id from the **English half of its eyebrow**, e.g.
`色彩 · COLOUR` → `colour`. This is deliberate: Chinese headlines get rewritten between drafts,
and votes keyed to them would orphan themselves.

The consequence is that **editing an eyebrow's English text orphans every answer already collected
for that section.** Rewriting the Chinese headline is always safe. If an English eyebrow genuinely
must change mid-round, migrate the stored rows first:

```bash
npx wrangler d1 execute zipa-review --remote \
  --command "UPDATE votes SET section='new-slug' WHERE section='old-slug'"
```

`results.html` carries a `SECTION_ZH` map from slug to Chinese label; add an entry there whenever a
section is added or renamed, or the results page will fall back to showing the raw slug.

## Layout

| Path | Role |
|---|---|
| `index.html` | The review page. Regenerated externally — see above. |
| `review-vote.js` | Injects the vote controls into every section. Self-contained, styles included. |
| `review-config.js` | The only place the Worker URL is written. |
| `results.html` | Aggregate view: tallies, who answered, every note, CSV, one-click agenda. |
| `worker/` | Cloudflare Worker + D1 that stores the answers. |

## Backend

Deployed at `https://zipa-review-api.zipapoker2025.workers.dev` (Worker `zipa-review-api`,
D1 database `zipa-review`, APAC region). `worker/DEPLOY.md` covers rebuilding from scratch.

Credentials live in `~/.config/cloudflare/zipa.env` (mode 600, outside every repo). Source it before
any wrangler command; the Bash tool does not carry environment between calls, so include it each time:

```bash
source ~/.config/cloudflare/zipa.env && cd worker && npx wrangler <command>
```

Never commit `worker/.dev.vars` or `worker/.wrangler/` — `worker/.gitignore` already excludes them.

Clear the table between review rounds:

```bash
source ~/.config/cloudflare/zipa.env && cd worker && \
  npx wrangler d1 execute zipa-review --remote --command "DELETE FROM votes"
```

## Security boundary

`REVIEW_CODE` is a shared passphrase, not authentication: anyone holding it can submit under any
name, and every colleague has it. `ALLOWED_ORIGIN` restricts browser calls to the Pages origin.
This is sized for an internal design review — do not put genuinely confidential material on the page.

## Pushing from WSL

The repo's `credential.helper` is set to the full Windows GCM path, because the bare `manager`
short name that Windows Git writes cannot be resolved from WSL:

```
/mnt/c/Program\ Files/Git/mingw64/bin/git-credential-manager.exe
```

If a fresh clone fails with `git: 'credential-manager' is not a git command`, set it again.
