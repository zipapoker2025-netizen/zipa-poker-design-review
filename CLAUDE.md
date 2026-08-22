# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The internal pre-meeting page for ZIPA POKER's design system / VI work, served by GitHub Pages at
https://zipapoker2025-netizen.github.io/zipa-poker-design-review/

`index.html` is currently **ZIPA POKER 設計系統／VI 資料彙整** — eight sections covering the D01–D12
decisions, colour options, the lexicon red lines, the account inventory, the poster template list,
platform specs and the format prerequisite map. It replaced the earlier 1A review page on 2026-08-22; that page is not
linked from anywhere any more but remains in git history.

The page is read on phones, so edits should hold that line: no fixed pixel widths, every table
inside `.tablewrap`, and prose kept to what a decision actually needs. Explanatory preamble and the
superseded 原建議 lines were cut on 2026-08-22 for that reason — resist adding them back.

The document is authored elsewhere and copied in whole. No build step, no dependencies. Push and
Pages redeploys.

Around it sits a response system so colleagues can register 同意／有疑慮／先保留 plus a note before the
meeting, and a results page that turns those answers into an agenda.

## Replacing index.html — read this first

Whatever produces `index.html` knows nothing about the two things this repo adds to it. After any
overwrite, restore both, or the page ships subtly wrong:

```html
<!-- immediately before </body> -->
<script src="review-config.js"></script>
<script src="review-vote.js"></script>
```

```html
<!-- in <head>, next to the viewport meta -->
<meta name="robots" content="noindex, nofollow, noarchive">
```

Losing the scripts costs every voting control, and **nothing errors** — the page renders perfectly,
just inert. Losing the robots meta quietly opens an internal document to crawlers. Verify both:

```bash
grep -c 'review-vote.js' index.html   # must be 1
grep -c 'name="robots"' index.html    # must be 1
```

Note that `ZIPA POKER Design System/review/index.html` in the sibling repo is a **fragment** with no
`<head>` or `<body>`. It is a different document and must not receive either addition.

## How the widget decides what gets a control

`review-vote.js` walks `.wrap > section, main > section, body > section` and, per section:

| Section | Behaviour | Vote id |
|---|---|---|
| `id="overview"` | skipped — a snapshot of where things stand, not a proposition | — |
| `id="decisions"` | one control per `.dcard` inside it, not one for the section | `decisions-d01` … from `.dcode` |
| anything else | one control for the whole section | the section's own `id` |

Both lists live at the top of the file as `SKIP_SECTIONS` and `CARD_SECTIONS`. `SKIP_SECTIONS` also
still names `sources`, which no longer exists — harmless, and correct again if it returns. A section with no
`id` falls back to the English half of its `.eyebrow` (`色彩 · COLOUR` → `colour`), which is how the
old 1A page worked and why that page's answers survived its Chinese headlines being rewritten.

**Vote ids must outlive edits to the prose.** Changing a section's `id`, or a card's `.dcode`,
orphans every answer already collected for it. Rewriting any Chinese text is always safe. If an id
genuinely has to change mid-round, migrate first:

```bash
npx wrangler d1 execute zipa-review --remote \
  --command "UPDATE votes SET section='new-id' WHERE section='old-id'"
```

Adding or renaming a section means updating **both** maps near the top of `results.html`'s inline
script: `SECTION_ZH` (id → Chinese label) and `SECTION_ORDER` (document order, which is what stops
D01–D12 from being scattered alphabetically among the sections). Regenerate them rather than
transcribing by hand — load the page in jsdom, run the widget, and read the ids back off the
rendered `.zpv` blocks.

## Styling

The widget carries no palette of its own. Every colour is
`var(--host-token, var(--1a-token, #literal))` — the host page's variables first, the old review
page's second, a literal last. That is what lets one file sit correctly in either document and
follow the current page into dark mode without knowing dark mode exists. Keep new rules to that
pattern; a hard-coded colour will look wrong in one theme or the other.

`results.html` defines its own tokens but mirrors the 彙整頁 values, including a dark mode. Its rule
bodies still speak in the old `--blue-800` / `--paper-050` names, so re-theming that page means
editing the `:root` blocks only. Red is split into `--red-fill` and `--red-ink` because one red
cannot serve as both a button fill and a label colour once dark mode flips the lightness.

## Layout

| Path | Role |
|---|---|
| `index.html` | The page. Authored externally — see above. |
| `review-vote.js` | Injects the controls. Self-contained, styles included. |
| `review-config.js` | The only place the Worker URL is written. |
| `results.html` | Tallies, who answered, every note, CSV, one-click agenda. Currently 18 vote points. |
| `worker/` | Cloudflare Worker + D1 that stores the answers. |

## Backend

Deployed at `https://zipa-review-api.zipapoker2025.workers.dev` (Worker `zipa-review-api`,
D1 database `zipa-review`, APAC). `worker/DEPLOY.md` covers rebuilding from scratch.

Credentials live in `~/.config/cloudflare/zipa.env` (mode 600, outside every repo). The Bash tool
does not carry environment between calls, so source it inside each command:

```bash
source ~/.config/cloudflare/zipa.env && cd worker && npx wrangler <command>
```

Never commit `worker/.dev.vars` or `worker/.wrangler/` — `worker/.gitignore` already excludes them.

Clear the table between review rounds:

```bash
source ~/.config/cloudflare/zipa.env && cd worker && \
  npx wrangler d1 execute zipa-review --remote --command "DELETE FROM votes"
```

Test against a local D1 instead of production with `npx wrangler dev --local` plus a `.dev.vars`
holding `REVIEW_CODE`; note that `--local` keys its database off `database_id`, so changing that
value in `wrangler.toml` starts a fresh local database that needs `schema.sql` applied again.

## Security boundary

`REVIEW_CODE` is a shared passphrase, not authentication: anyone holding it can submit under any
name, and every colleague has it. `ALLOWED_ORIGIN` restricts browser calls to the Pages origin.
This is sized for an internal meeting — do not put genuinely confidential material on the page.

## Pushing from WSL

`credential.helper` is set globally in `~/.gitconfig` to the full Windows GCM path, because the bare
`manager` short name that Windows Git writes cannot be resolved from WSL. A repo cloned on the
Windows side re-introduces a local override that outranks the global setting; clear it with
`git config --local --unset credential.helper`.
