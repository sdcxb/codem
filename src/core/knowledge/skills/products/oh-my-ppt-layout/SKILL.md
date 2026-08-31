---
name: oh-my-ppt-layout
description: Must be read before creating, relaying out, or repairing Oh My PPT slide layouts. Defines the per-page decision path, the named layout pattern catalog, canvas budgeting, collision avoidance, chart overpack guardrails, and title readability rules.
---

# Oh My PPT Layout

This skill is the decision backbone for slide structure. Deep examples live in the references:

- `references/catalog.md` — canonical 1600×900 zone skeletons and named layout patterns (the structure-choice layer you pick from before writing HTML).
- `references/layout.md` — collision-avoidance code comparison and height-budget walkthroughs.
- `references/checklist.md` — P0/P1/P2 structural self-check.

## When to use

- Creating a new slide or rewriting a whole slide
- Choosing a slide composition or layout intent (cover, data-focus, comparison, etc.)
- Repairing overflow, collision, or content exceeding the canvas

## When not to use

- Tiny text/style edits that do not affect layout (color, wording, single element)

## 1. The per-page decision path

Before writing HTML, answer these in order. The first three decide the role and density; the rest decide structure and budget.

0. **PPT message** — what is the one sentence this page should make the audience remember within 3 seconds? Source material is evidence; the slide is an edited message.
1. **Role** — what is this slide? (cover / data exhibit / comparison / timeline / concept / process / summary / quote / image-focus)
2. **Reading path** — what does the audience see first → understand second → remember last?
3. **Content shape** — which source facts support the message, which can be grouped, and which becomes compact secondary detail? A slide is a designed argument, not a document dump.
   - If the page feels over-dense or would exceed 1600×900, pause before writing HTML and self-summarize: one message + 2-4 support groups/evidence rails. Only place that distilled structure on the slide; merge minor facts into labels, notes, annotations, or omitted speaker-context.
4. **Density** — low (generous whitespace, one hero), medium (main + 1–2 support), or high (grid/table/matrix only when the content truly demands it)?
5. **Pattern + skeleton** — pick a named layout pattern from `references/catalog.md`; if the page risks becoming top-heavy, also pick one canonical 1600×900 zone skeleton. Do not invent a layout from zero when a pattern fits.
6. **Height budget** — calculate the height budget so the chart and modules fit within 900px with intentional whitespace (see §4).
7. **Self-check width/height**: Before calling the write tool, estimate the final layout. Width must fit 1600px and height must fit 900px, including padding, title/subtitle, rows, gaps, chart frames, footnotes, and likely text wrapping. If either dimension exceeds the canvas, redesign the composition and check again.

Then **sketch the layout before writing** (kept in your head, not emitted to the page). Picture the page as zones — what sits in each zone, roughly how tall, and how the zones balance across the full 1600×900. Confirm the sketch has a clear primary focus, readable whitespace, and no accidental large empty band; only then write the HTML. A quick shape for the sketch:

```text
role: data-focus
density: medium
pattern: trend-exhibit
skeleton: chart-plus-insight-stack
zones: title/claim (~80, top) · dominant chart/visual middle (~420-500) · 1-2 metric chips or one insight band attached to chart · optional footnote — balanced, no accidental empty band
balance check: 3-second message visible, clear primary focus, readable whitespace, no crowded second support row
density check: if the source has too many facts, summarize before writing; do not turn every fact into a visible card
image policy: standard mode, no image request slot
```

The sketch is a thinking aid, not a template — keep the composition creative; just make sure the planned zones feel intentional and breathable before you write. The chosen pattern and skeleton are what you check against the structure recipe in `catalog.md`.

## 2. Layout pattern catalog entry

The catalog is advisory — patterns and skeletons are structure choices, not templates. Any pattern is re-visualized by the current style; the structure stays the same while style owns the look. Canonical 1600×900 skeletons and full four-part pattern definitions (input shape / structure recipe / budget rule / failure signs) are in `references/catalog.md`. Intent → pattern quick lookup:

| Intent | Patterns |
| --- | --- |
| `cover` | hero-title-center · hero-title-asymmetric · hero-big-number · section-divider |
| `quote` | hero-quote |
| `summary` | summary-takeaways · executive-brief |
| `data-focus` | kpi-hero · metric-band · trend-exhibit · chart-annotated |
| `comparison` | compare-two-zone · compare-options · decision-matrix |
| `concept` | concept-center-satellites · framework-2x2 · framework-pyramid |
| `process` | process-linear · process-loop |
| `timeline` | timeline-strip |
| `image-focus` | asset-image-hero · asset-text-visual-split |

The same role and density can produce several valid patterns — pick the one whose reading path and module count best match the content.

## 3. Canvas and spacing

- Design for 16:9 canvas: 1600×900. The runtime page root has no default padding.
- Full-bleed backgrounds may use the entire 1600×900 canvas. Authored content must still use a conservative safe content budget with 24-40px spare height.
- Use Tailwind grid/flex layout. The root container usually uses `w-full h-full`; avoid fixed pixel values on the root.
- All content must be fully visible within the canvas. When space is tight, preserve the information by changing the composition: asymmetric split, bento grid, evidence rail, timeline strip, layered callout, compact table, grouped labels, or side-by-side zones.
- Background fills the entire canvas, defined on the outermost container.
- Body copy, ordinary labels, and card descriptions must be at least `text-lg` (18px).
- Every heading must be at least `text-2xl` (24px); this is a floor, not a fixed heading size. Use larger heading scales up to `text-5xl` (48px) when hierarchy calls for them.
- Annotations, footers, page numbers, source/citation lines, and other genuinely auxiliary text may be smaller than 18px, but must remain at least 12px. Use semantic `<footer>`, `<small>`, or `<figcaption>` elements, or mark a non-semantic wrapper with `data-ppt-text-role="auxiliary"`. Do not use this exemption for body copy, ordinary labels, or card descriptions.
- Decorative chips, badges, status tags, and compact KPI units that intentionally use the 12–17px auxiliary range must carry `data-ppt-text-role="auxiliary"`; otherwise they are ordinary labels and the 18px body floor applies.
- The visual center can sit slightly above the geometric center for projection comfort. This is a balance correction, not permission to stack all modules in the top half.

### Body content uses grid/flex flow

- Lay out body content with grid/flex document flow.
- Use the 900px canvas with presentation-like breathing room. The page should not look accidentally top-heavy or half-empty, but modules do not need to fill every remaining pixel. Make the main content zone clear, size charts/tables/cards to feel intentional, and keep whitespace as part of the composition.
- Use `absolute` / `fixed` only for background decoration, connectors, and non-text visual accents.
- Elements containing h1, h2, h3, p, li, or primary slide text use grid/flex cells, not absolute positioning.
- Put `gap-*` on grid/flex containers. Put `min-w-0` on long-text children.
- Avoid combining h-full, min-h-*, large padding, large gaps, and multi-paragraph text across nested vertical levels.
- For radial/surround/center-image layouts: use an explicit grid (e.g. 3-col 3-row), put each module in its own cell, and use connector lines as an SVG decoration layer.

For code comparison of collision-prone vs reliable structures, read `references/layout.md`.

## 4. Height budgeting

Total canvas: **1600px wide × 900px tall**. Before writing HTML, calculate the height budget in order — you run this calc yourself per page, there is no preset module size to copy:

1. Outer padding (e.g. `p-6` = 48px, `p-8` = 64px)
2. Title + subtitle area (~60–80px including gap)
3. Gaps between modules (each `gap-4` = 16px, `gap-6` = 24px)
4. Safety reserve (24–40px; use 40px for dense chart/table slides)
5. Remaining = maximum space for chart/data modules. Size the primary module so the page feels intentional, while preserving readable whitespace. Do not leave modules small at the top with a large accidental empty band, and do not fill the slot by adding unnecessary cards.

Chart frame `h-[Npx]` must fit within the remaining space and feel intentional. Chart.js cannot use `flex-1` / `h-full`, so first calculate the content slot, subtract support modules, then choose a role-appropriate chart height from the chart slot: hero/main 380–560px only when the chart is the dominant module, standard 280–360px, compact support 220–280px — these mirror the chart skill, which owns the full slot calc and role guide; read it before writing a chart. The chart skill's height comment must include the dedicated marker `@ppt-chart-height=N`, and the `h-[Npx]` class must use the same number. Never write `chart height = 420` and then output `h-[240px]`. If the total exceeds 900px or becomes too dense, change the composition and hierarchy before shrinking everything.

In side-by-side or multi-column layouts, columns share width, not height. Do **not** divide the vertical content slot by the number of columns (for example, no `732/2` just because the page has left metrics and a right chart). Each column starts with the same vertical content slot; subtract only the modules stacked vertically inside that same column. A metric rail beside the chart affects width and hierarchy, not the chart height calculation.

Charts, tables, timelines, and long lists must share the same budget as titles and notes. Budget the chart frame height before writing HTML. Full walkthroughs are in `references/layout.md`.

## 5. Overpacked chart slide guardrails

Do not treat the missing runtime padding as permission to add more content. The slide canvas is full height, but dense content still needs breathing room.

- If a slide has a main chart or two tall data cards, support modules are capped at 1-2 compact blocks; use 3 only for genuinely parallel short facts.
- Do not create two-row bottom card grids below a tall chart, a two-column main area, or a long title. Six facts below a chart should be re-composed into a better data layout: evidence rail, small multiples, compact band, annotated chart, or table-like rows.
- A `grid-cols-3` support row may contain at most 3 cards. If there are 4–6 facts, choose a density-appropriate structure: bento grid, metric band, compact comparison, annotated chart, or table/list.
- Content expansion does not override density. When the page already has enough facts, charts, cards, or paragraphs, stop adding modules and instead group, merge, or translate details into labels, annotations, compact rows, or in-chart callouts.
- Avoid `flex-1 min-h-0` main content followed by an uncapped bottom grid. Give rows explicit budgeted heights (`grid-rows-[auto_1fr_auto]`, `max-h-*`) or redesign the support area as part of the main composition.
- Footnotes are optional on crowded data slides. If kept, they must be a single short line included in the height budget.

For chart slides, decide the chart role before choosing layout density:

- If the chart is the main evidence, give it one dominant zone and keep support modules to 1-2 compact blocks.
- If the chart is supporting evidence, keep it compact and let the primary claim or comparison own the visual hierarchy.
- If the page needs more than one chart, use equal chart frames only when the charts are truly comparable; otherwise make one primary and one compact.
- Do not pair a tall chart with a full metric row, long subtitle, summary cards, and footnotes in full card form. Redesign the relationship between chart and evidence so one element is primary and the others are visibly supporting.

## 6. Title readability

Titles are part of the reading path, not a fixed header decoration.

- Cover/summary slides: title can be at visual center.
- Data slides: title can be near a key number or beside the chart.
- Comparison slides: title where it clarifies the contrast.
- Within one deck, vary title position and card grid across consecutive pages.
- Vertical title text: only for short Chinese labels of 2–6 characters.
- Titles with English, numbers, years, mixed text, or long phrases must be horizontal.

## 7. Avoid accidental under-fill without overloading the page

This section applies to **content and data pages**. Real PPT pages use whitespace; low-density pages — cover, big-number, quote, section-divider — use even more. The failure is not whitespace itself; the failure is accidental under-fill where a few tiny modules sit at the top and the rest of the slide feels forgotten. Two forms hit this skill:

- **Thin content** — the source gave one idea or number, or the provided material is not enough to support a page. Supplement lightly from the source material into a clearer visual argument instead of centering a few small cards.
- **Under-filled data page** — there is a chart plus a short card row, but together they cover only part of the height and leave a large empty band. The heights were never budgeted to fill the canvas (see §4).
- **Top-heavy skeleton failure** — the slide has a valid title and several modules, but they all sit in the upper half while the middle/lower canvas is mostly background. Pick a canonical 1600×900 skeleton from `catalog.md` and redistribute the zones.

Before expanding, decide whether the page is truly sparse. A full source table, a multi-indicator comparison, or a chart plus a clear takeaway is already enough content; do **not** add more cards or a second summary layer. In those cases, fix whitespace by hierarchy, spacing, grouping, chart/table sizing, and compact annotations — not by adding content.

When the page content is truly sparse, supplement and expand in-page from the source material with substance (not decoration), but keep the result low-to-medium density. Strategies:

1. **Expand the argument** — add context, comparison, baseline, reason, implication, or a "so what" line.
2. **Add a visual anchor** — a diagram, axis, progress bar, timeline strip, comparison bracket, or quadrant using divs/SVG.
3. **Evidence rail** — 1–2 supporting cards or metric chips alongside the main message; use 3 only when they are very short and parallel.
4. **Split into zones** — claim + evidence, number + context, before + after, cause + effect.
5. **Give the main idea its full zone** — scale up the hero number or chart so it owns its zone; a larger hero reads better than an empty band.
6. **Pair a modest chart with right-sized support** — if a chart's zone is much taller than the chart needs (e.g. a 5-bar chart in a ~600px cell), do not stretch the chart to an awkward height. Keep the chart at a readable size and use the remaining space only for the support the content actually needs, in whatever form best serves the reading path.

Expansion is conditional and conservative. If the slide is already medium/high density, or if the source already provides enough facts for the page, the fix is not more content; it is compression and hierarchy. Turn extra facts into a short evidence rail, compact table rows, grouped bullets, chart annotations, or one key-takeaway band so the page still fits 1600x900 cleanly with breathing room.

Stay grounded: extend from the source material's theme, conclusions, and data direction. Reasonable inference, explanation, implication, and framing are allowed; do not invent unsupported specific facts, numbers, cases, quotes, or source claims.

For dense source tables or lists, preserve the source meaning by editing it into a presentation, not by mirroring the document. Choose one primary expression (timeline, table, chart, hero metric, or comparison) and avoid repeating the same fact again as equal-weight summary cards. If all rows truly matter, use a compact table/timeline or split the material across pages; do not stack full cards until the slide becomes a data archive.

These map directly onto catalog patterns (`summary-takeaways`, `kpi-hero`, `compare-two-zone`, `concept-center-satellites`, etc.).

## 8. Deck-level rhythm

Across a deck, vary the structure so consecutive slides feel different, not like the same template with swapped content.

- Alternate hero and non-hero pages: a low-density hero/cover/big-number/quote page should break up runs of dense data or comparison pages.
- Do not mechanically reuse the same card grid, chip row, or table pattern across slides. Vary the pattern, the column count, and the title position.
- Vary support density: most pages should be one dominant module with 0–2 chips; only some pages need a 3-card grid.

> Limitation: deck-level rhythm applies to the deck-generation main flow where the model writes several pages in sequence. Single-page edit does not control neighbor pages, so it only needs to fit the page it is given.

## 9. Style coordination (boundary and priority)

Oh My PPT separates two concerns:

- **Structure** (this skill): information organization, reading path, spatial budget, chart/body load-bearing relationship, and structural failure avoidance.
- **Visual language** (the user's chosen style): color, typography feel, decoration, corners, shadows, gradients, and overall aesthetic.

The current style may include its own "layout" advice and composition tendencies; that is expected. When style and this skill interact:

- **Structural safety has priority.** Collision, overflow, content overload, body text below 18px, headings below 24px, or auxiliary text below 12px are backed by this skill and override the style's composition tendency. Auxiliary annotations, footers, page numbers, and source/citation lines are exempt from the 18px body floor, not from the 12px auxiliary floor. A style suggestion that would push text into absolute positioning, shrink text below its semantic floor, or overflow the canvas loses to this skill.
- **Visual language is the style's alone.** Do not let any pattern in the catalog pull the page toward a fixed external look. Run the style-swap self-check: the same pattern must hold under any other style without pointing at one fixed visual.

When a style's "layout" section conflicts with a structural rule here, follow the structural rule and keep the style's visual treatment.

## 10. Failure repair strategy

When a slide overflows, collides, exceeds the canvas, or is under-filled (a large empty band because the modules cover only part of the height):

1. **Revisit density and hierarchy first** — decide what should be hero, support, annotation, or background.
2. **Change the pattern** — switch to a different catalog pattern whose structure recipe absorbs the content better (e.g. from a card grid to an evidence rail, bento grid, metric band, or timeline strip).
3. **Change representation** — convert full cards into labels, bands, rows, annotations, or compact modules only when the density calls for it.
4. **Rebudget chart height** — if the page has a chart, calculate the content slot, subtract support modules to get the chart slot, and choose a role-appropriate `h-[Npx]`; update the height comment so the final number matches the class.
5. **Check nesting** — flatten any deep wrapper chains that consume vertical space.

For under-fill (the mirror problem), apply §7: enlarge the primary module modestly, improve spacing, or add one substantive evidence/annotation zone in-page. Do not patch an empty page with decorative filler or a pile of new cards.

For the full P0/P1/P2 self-check list, read `references/checklist.md`.

## 11. Cross-skill references

- Before writing a slide, run the per-page decision path (§1) and pick a pattern from `references/catalog.md`.
- When a slide needs a chart, budget the chart frame height first (see chart skill), then lay out the remaining modules; keep support to 0–2 compact blocks by default (see §5).
- Animation should follow the reading path (see animation skill), not replace layout.
- When self-checking before delivery, consult `references/checklist.md`.
