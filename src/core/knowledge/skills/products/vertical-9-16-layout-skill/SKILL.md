---
name: vertical-9-16-layout-skill
description: Must be read before creating, relaying out, or repairing 9:16 vertical Oh My PPT pages. Defines mobile-story layout, top/middle/bottom zone planning, vertical flow patterns, height budgeting, readable chart/list composition, plus catalog and checklist references for 900x1600 canvases.
---

# Vertical 9:16 Layout Skill

This skill is the layout source of truth for `vertical-9-16` pages, usually 900x1600.

A 9:16 page is a vertical story screen. Its strongest layouts feel like a designed reading sequence: a top hook, a middle value zone, and a bottom conclusion or support area. The job is to make the page scan from top to bottom without becoming a stack of unrelated cards.

**This canvas is a vertical story frame, not a compressed slide.** When the source content is dense or "needs to be summarized", the model MUST summarize harder here, not cram the full outline into one page. A 9:16 page that tries to hold a 16:9 deck's worth of content will overflow no matter how the fonts are tuned.

Deep details live in the references:

- `references/catalog.md` - named vertical story patterns and 900x1600 zone skeletons.
- `references/checklist.md` - P0/P1/P2 structural self-check for delivery.

## Preflight

Before writing HTML, decide:

1. **Message** - the one sentence this screen should make the viewer remember.
2. **Hook** - the first visual/text anchor: claim, question, number, quote, or compact image/data object.
3. **Main value** - the proof, explanation, comparison, steps, or data that makes the hook useful. Hard cap: **2-3 supporting modules** (or **4-5 compact list rows** for ranked/steps). Anything beyond MUST be cut, merged, or promoted to one hero object — never squeezed in by shrinking fonts.
4. **Bottom role** - takeaway, implication, source, callout, or final support.
5. **Density** - low for hero claim/quote, medium for most explainers, high only for compact ranked lists or step pages. Never use "high density" as a reason to exceed the 3-module cap.
6. **Pattern** - choose one structure from `references/catalog.md` before writing HTML.
7. **Budget** - estimate title wrapping, section heights, gaps, chart/list height, and bottom reserve against the current canvas.

Use the canvas dimensions from the prompt. If custom dimensions are supplied, scale the same vertical relationships to that height and width.

## Canvas Grammar

- Work in a vertical stack. The page should have a clear top, middle, and bottom.
- Use one dominant focal object, then 2-4 supporting modules.
- Keep the middle zone load-bearing. A page with only small modules near the top feels unfinished.
- Use full-width sections by default. A compact two-column pocket is acceptable only inside one short section when both columns stay readable.
- Use grid/flex document flow for text-bearing modules. Absolute positioning is only for background accents, connector lines, and non-text decoration.
- **Capacity ceiling (hard)**: per page = 1 hook + up to 3 supporting modules (or 5 compact list rows) + 1 bottom takeaway. A "module" is a labeled section, a comparison row, a step group, or a data block — not a single bullet. If the outline gives you more points than this ceiling, the page agent resolves overload IN-PAGE by compressing/merging/rewriting into fewer denser modules; never by shrinking font below the floors, never by splitting into multiple pages.
- **Vertical fill (hard)**: the page must use the full canvas height with no accidental top-stack or bottom gap. The main content wrapper MUST be `flex flex-col` with at least one `flex-1` / `flex-grow` child absorbing leftover height (typically the middle value module), OR use `justify-between` to spread hook / value / bottom across the canvas. Never set fixed top padding (`pt-[NNpx]`) and let content stack from the top while the bottom is empty. If content is shorter than the canvas, the `flex-1` block expands; if longer, you have exceeded the capacity ceiling — compress.
- Body copy, ordinary labels, and card descriptions must be at least **32px** (Tailwind `text-3xl` is 30px — too small, use `text-[32px]` or `style="font-size:32px"`); headings must be at least **43px** (`text-[43px]` or larger, `text-4xl`/`text-5xl`); auxiliary source/footer text must be at least **21px** (`text-[21px]` or `text-xl`). These floors compensate for the much smaller fit-scale a 1600h canvas gets on a landscape presentation screen — default `text-lg`/`text-xl` (18px/20px) will be unreadable, do not use them on this canvas.

## Pattern Quick Lookup

| Intent | Patterns |
| --- | --- |
| hook / summary | `hook-value-takeaway` · `hero-claim` |
| process | `vertical-step-story` |
| comparison | `stacked-comparison` |
| data | `data-takeaway` · `ranked-list` |

Use `references/catalog.md` for the full structure recipe before writing a new or heavily repaired page.

## Height Budget

Calculate before writing:

1. Canvas height: usually 1600px.
2. Outer vertical padding: commonly 64-112px total.
3. Hook/title zone: usually 180-360px after wrapping.
4. Gaps between sections.
5. Bottom takeaway/support/source: usually 160-320px when present.
6. Safety reserve: 40-64px.
7. Remaining height is the main value zone.

For charts, reserve a specific frame height and keep the `@ppt-chart-height=N` marker aligned with the `h-[Npx]` class. Prefer compact bars, rank lists, simple trends, or hero metric + interpretation when the data has many labels.

## Repair And Self-check

- If the page feels top-heavy, enlarge or move the main value object into the middle and give the bottom a real takeaway.
- If the page feels like a long list, group items into 2-4 sections or promote one item to hero.
- **If the outline oversupply exceeds the 3-module ceiling, resolve overload in this priority: (1) summarize and compress — say the same information in fewer words (long descriptions become short phrases, sentences become single data points; remove water, not information), (2) merge related points into one module with a shared label, (3) rewrite a long list as one hero metric + one-line interpretation, (4) switch pattern to a denser format (e.g. comparison stack, ranked list). Never resolve overload by going below the font floors or by exceeding the canvas height.**
- If text feels cramped, shorten copy and group evidence; do not reduce semantic font floors.
- If a chart/list is hard to read, switch to a hero metric, rank list, compact bars, or grouped rows.
- If the bottom is decorative only, replace decoration with conclusion, implication, source, or final support.
- Before delivery, run `references/checklist.md`.
