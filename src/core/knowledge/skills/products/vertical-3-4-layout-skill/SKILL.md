---
name: vertical-3-4-layout-skill
description: Must be read before creating, relaying out, or repairing 3:4 vertical Oh My PPT pages. Defines poster-card layout, focal hierarchy, vertical section planning, evidence grouping, compact two-column pockets, chart/list budgeting, plus catalog and checklist references for 1200x1600 canvases.
---

# Vertical 3:4 Layout Skill

This skill is the layout source of truth for `vertical-3-4` pages, usually 1200x1600.

A 3:4 page is a vertical poster-card canvas. It has enough width for rich information cards and compact two-column pockets, but its reading path is still vertical. The layout should feel like a poster with one strong anchor and grouped evidence, not a long feed of equal blocks.

**This canvas is a poster card, not a compressed slide.** When the source content is dense or "needs to be summarized", the model MUST summarize harder here, not cram the full outline into one page. A 3:4 poster that tries to hold a 16:9 deck's worth of content will overflow no matter how the fonts are tuned.

Deep details live in the references:

- `references/catalog.md` - named poster-card patterns and 1200x1600 zone skeletons.
- `references/checklist.md` - P0/P1/P2 structural self-check for delivery.

## Preflight

Before writing HTML, decide:

1. **Message** - the one sentence this card should make the viewer remember.
2. **Focal anchor** - title block, hero metric, chart, image/diagram, framework, or conclusion.
3. **Support groups** - hard cap **3-4 support bands** (or **5-6 compact rows/chips** for grouped facts). Anything beyond MUST be cut, merged, or repackaged as one hero object — never squeezed in by shrinking fonts.
4. **Reading path** - top claim -> main proof/value -> bottom synthesis/source.
5. **Density** - low-medium for poster claims, medium for most information cards, high only for compact lists or matrices. Never use "high density" as a reason to exceed the 4-band cap.
6. **Pattern** - choose one structure from `references/catalog.md` before writing HTML.
7. **Budget** - estimate hero zone, main proof zone, bottom synthesis, gaps, and reserve.

Use the canvas dimensions from the prompt. If custom dimensions are supplied, preserve the same vertical poster relationships.

## Canvas Grammar

- Keep one visual or conceptual anchor larger than the rest.
- Use vertical sections, but group small facts into bands, rows, or chips so the card does not become a long list.
- A compact two-column pocket is allowed inside one section when each item remains readable.
- Let the bottom carry synthesis, implication, source, or a final evidence band.
- Use grid/flex document flow for text-bearing modules. Absolute positioning is only for background accents, connector lines, and non-text decoration.
- **Capacity ceiling (hard)**: per page = 1 focal anchor + up to 4 support bands (or 6 compact rows/chips) + 1 bottom synthesis. A "band" is a labeled section, a comparison row group, an evidence cluster, or a step group — not a single bullet. If the outline gives you more points than this ceiling, the page agent resolves overload IN-PAGE by compressing/merging/rewriting into fewer denser bands; never by shrinking font below the floors, never by splitting into multiple pages.
- **Vertical fill (hard)**: the page must use the full canvas height with no accidental top-stack or bottom gap. The main content wrapper MUST be `flex flex-col` with at least one `flex-1` / `flex-grow` child absorbing leftover height (typically the support group or the bottom synthesis), OR use `justify-between` to spread focal / support / synthesis across the canvas. Never set fixed top padding (`pt-[NNpx]`) and let content stack from the top while the bottom is empty. If content is shorter than the canvas, the `flex-1` block expands; if longer, you have exceeded the capacity ceiling — compress.
- Body copy, ordinary labels, and card descriptions must be at least **32px** (Tailwind `text-3xl` is 30px — too small, use `text-[32px]` or `style="font-size:32px"`); headings must be at least **43px** (`text-[43px]` or larger, `text-4xl`/`text-5xl`); auxiliary source/footer text must be at least **21px** (`text-[21px]` or `text-xl`). These floors compensate for the much smaller fit-scale a 1600h canvas gets on a landscape presentation screen — default `text-lg`/`text-xl` (18px/20px) will be unreadable, do not use them on this canvas.

## Pattern Quick Lookup

| Intent | Patterns |
| --- | --- |
| poster claim | `poster-hero-proof` |
| metric / data | `hero-metric-explainer` · `data-card` |
| process | `vertical-process` |
| comparison | `comparison-rows` |
| evidence | `evidence-band-stack` · `two-column-pocket` |

Use `references/catalog.md` for the full structure recipe before writing a new or heavily repaired card.

## Poster Budget

Calculate before writing:

1. Canvas height: usually 1600px.
2. Outer vertical padding: commonly 72-128px total.
3. Hero/title zone: usually 240-420px depending on focal scale.
4. Gaps between sections.
5. Bottom conclusion/source/reserve: 80-240px when present.
6. Remaining height is the main proof/value zone.

Canvas width is usually 1200px. After horizontal padding, use one full-width column or one compact two-column pocket.

For charts, reserve a specific frame height and keep the `@ppt-chart-height=N` marker aligned with the `h-[Npx]` class. Prefer one clear chart, hero metric, compact bars, rank list, or short table.

## Repair And Self-check

- If the card is just a stack of cards, introduce a hero/focal block.
- If the bottom is empty, add synthesis, implication, source, or a final evidence band.
- If there are too many small facts, group them into bands or chips under shared labels.
- **If the outline oversupply exceeds the 4-band ceiling, resolve overload in this priority: (1) summarize and compress — say the same information in fewer words (long descriptions become short phrases, sentences become single data points; remove water, not information), (2) merge related points into one band with a shared label, (3) rewrite a long list as one hero metric + one-line interpretation, (4) switch pattern to a denser format (e.g. comparison rows, ranked chips). Never resolve overload by going below the font floors or by exceeding the canvas height.**
- If a two-column pocket feels cramped, return to full-width rows.
- If a chart/table is hard to read, convert it to a hero metric, rank list, compact bars, or grouped rows.
- Before delivery, run `references/checklist.md`.
