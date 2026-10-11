# FLOWOS brand

The mark, wordmark, colors and brand motion. Code lives in
`client/src/components/brand.tsx` (components), `client/src/lib/brand.ts`
(when the intro plays) and the "Brand" sections of `client/src/styles.css`.
No libraries, fonts or network requests are involved: everything is inline SVG
and CSS.

## Concept

FLOWOS turns scattered operational work into decisions and action. The mark
shows that loop: **four corner pieces** (streams of work, each entering through
its own gap) **lock around one diamond core** (the decision point). The gaps
sit off-centre and in rotational order, so the frame reads as flow without
implying spin. The rounded corners echo the product's radius tokens.

The wordmark is drawn, not typeset: monoline strokes with the mark's rounded
corners. The O of _OS_ carries the core, which ties the word to the symbol.

| Asset      | Where                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `LogoMark` | sidebar, mobile top bar, sign-in stage, loader, chat                                                                                            |
| `Wordmark` | sidebar, mobile top bar, sign-in stage                                                                                                          |
| Icon only  | `client/public/favicon.svg` (tile), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` (full-bleed, maskable safe zone), `site.webmanifest` |

The static icons use the same path data as `MARK_PIECES` (a unit test keeps
them in step). The PNGs were rendered from that SVG with the bundled Chromium.

## Color and material

The product UI keeps its warm paper and graphite palette. The brand adds a
**deep navy-graphite stage** for brand surfaces only (the sign-in art panel and
the app icon), with **steel-blue streams** and the existing **teal-cyan core**
as the single accent. There is no constant glow: light appears briefly in the
intro and as an occasional edge light.

| Token                  | Light     | Dark      | Use                          |
| ---------------------- | --------- | --------- | ---------------------------- |
| `--brand-stage`        | `#0c1319` | same      | sign-in stage, app icon      |
| `--brand-stage-2`      | `#15212b` | same      | stage gradient               |
| `--brand-flow`         | `#2f4a63` | `#9bb8d6` | mark pieces on page surfaces |
| `--brand-core`         | `#0b9b91` | `#2ccfbc` | core (the teal accent)       |
| `--brand-flow-on-dark` | `#9bb8d6` |           | pieces on dark surfaces      |
| `--brand-core-on-dark` | `#2ccfbc` |           | core on dark surfaces        |
| `--brand-glint`        | `#e4fffb` |           | edge light (motion only)     |

Contrast: pieces `#2f4a63` on paper ≈ 8:1, `#9bb8d6` on the stage ≈ 9:1, the
core on either ≥ 3:1. The headline accent and the loop's EXECUTE on the stage
use `--brand-core-on-dark` (≈ 9:1). `LogoMark tone="mono"` draws everything in
`currentColor`; in Windows high-contrast mode the mark uses `CanvasText`.

## Motion

All brand motion uses transform, opacity, `clip-path` (wordmark) and
`stroke-dashoffset` (edge light) only. It reuses the motion tokens (`--ease`,
`--ease-in-out`, `--dur-*`). Under `prefers-reduced-motion` none of it runs:
no intro, no ambient motion, no motion control.

| Motion                      | Where             | When                                                                                             |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| **Intro** (~5 s)            | sign-in art panel | first visit in this browser                                                                      |
| **Short reveal** (~1.4 s)   | sign-in art panel | a returning visitor's new session                                                                |
| No replay                   | all auth pages    | later route changes or reloads in the same session                                               |
| Ambient breath + edge light | sign-in emblem    | after the intro; aura 7 s cycle, edge light every 9 s; **Pause animation** stops it (remembered) |
| Working                     | sign-in emblem    | only while a sign-in / sign-up / reset / invite request is in flight                             |
| Compact convergence (~1 s)  | sidebar mark      | first app-shell mount per session                                                                |
| Lean-in on hover/focus      | sidebar home link | interaction                                                                                      |
| Loader                      | full page         | only while the session check is loading; fades in after 240 ms                                   |
| Working mark                | assistant chat    | only while a reply is on its way and no text has arrived yet                                     |

Intro timeline (full; the short reveal is the same choreography at 0.28×):
aura in (0–1.4 s) → pieces converge from their corners, staggered (0.3–2.1 s)
→ core lights (1.7–2.3 s) → ring and edge light (2.0–3.3 s) → wordmark reveals
(2.3–3.1 s) → the emblem settles from the centre to its resting place
(3.2–4.1 s) → headline rises (3.7–4.5 s) → the loop words follow (4.1–4.8 s).

The intro never blocks anything: it plays inside the art panel while the form
beside it works from the first frame. **Skip intro** (or Escape) ends it at
once and keeps focus on the same control, which becomes **Pause animation**.
No focus is moved or trapped, there is no sound, and the dashboard never shows
an intro. State: `sessionStorage flowos.intro.played`, `localStorage
flowos.intro.seen`, `sessionStorage flowos.shell.revealed`, `localStorage
flowos.motion.paused`; with storage blocked an in-memory fallback still
prevents replays within the page.

## Usage rules

- `state="working"` only for real work in progress; never as decoration.
- Do not recolor, stretch, rotate or add effects to the mark; use `tone`.
- Minimum size: 16 px (favicon); below 24 px use the mark without the wordmark.
- The brand stage colors are for brand surfaces; product UI stays on the
  paper/graphite tokens.
