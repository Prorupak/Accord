# Accord UI design system

This is the canonical visual reference for Accord. It describes what is implemented, not what is
aspired to. The runtime source of every value is the `@theme static` block in
`web/app/globals.css` (Tailwind 4.3). This document explains those values, and the
`accord-design-system` Claude skill (`.claude/skills/accord-design-system/`) enforces them. If the
two disagree, `globals.css` wins: fix this document.

Direction (spec §11.1): **editorial precision, quiet intelligence.** That means an off-white canvas,
white surfaces, near-black ink, one restrained blue, hairline rules, and hierarchy carried by
type and space. There are no gradients, glows, glass effects or decorative charts, and no nested
rounded cards. The UI is light-only in v1.

## How to consume tokens

- **In TSX:** use the Tailwind utilities generated from the tokens, such as `bg-canvas`,
  `bg-surface`, `text-ink`, `text-muted`, `border-line`, `text-error`, `bg-accent-soft`,
  `text-section`, `rounded-panel`, `px-gutter`, `max-w-content`, `min-h-control` and `p-panel`.
- **In CSS** (only in `globals.css`): use `var(--color-…)`, `var(--text-…)`, `var(--spacing-…)`,
  `var(--radius-…)`.
- **Never** put hex values, `rgb()` values or Tailwind palette names (`red-700`, `blue-50`) in
  components. `--color-*: initial` removes Tailwind's default palette, so those classes generate
  nothing.
- **Adding a token** is allowed only for a genuinely reusable role. Add it to the `@theme` block
  and to this document in the same change. Do not create a near-duplicate.

## Colour

All values are from spec §11.2. `line-strong` is the one addition (see "Decisions").

| Token (utility suffix) | Value | Role |
| --- | --- | --- |
| `canvas` | `#FAFAFA` | Page background |
| `surface` | `#FFFFFF` | Inputs, tables, panels; text on accent fills |
| `ink` | `#17191D` | Primary text, headings |
| `muted` | `#5F646D` | Secondary text, table headers, metadata |
| `line` | `#DFE2E7` | Decorative hairlines and dividers (the default `border` colour) |
| `line-strong` | `#868B94` | Boundaries that identify a control: buttons, inputs, selects |
| `accent` | `#244BEA` | Primary action, current/selected state, focus ring, drag-over |
| `accent-soft` | `#EEF2FF` | Selected row or toggle background |
| `success` / `success-soft` | `#166534` / `#F0FDF4` | Matched / confirmed states |
| `review` / `review-soft` | `#92400E` / `#FFFBEB` | Needs the user's decision, caution |
| `error` / `error-soft` | `#B91C1C` / `#FEF2F2` | Errors, blocked conflicts, invalid input |
| `transparent`, `current` | | Utility keywords kept after the palette reset |

Measured contrast (WCAG 2.2: text ≥ 4.5:1, control boundaries and focus ≥ 3:1):

| Pair | Ratio | Use |
| --- | --- | --- |
| ink on canvas | 16.86 | Body text |
| muted on canvas / surface | 5.70 / 5.95 | Secondary text passes as normal-size text |
| accent on canvas | 6.15 | Links, focus ring, accent text |
| surface on accent | 6.42 | Primary button label |
| accent on accent-soft | 5.74 | Selected toggle label |
| success on success-soft | 6.81 | Status text |
| review on review-soft | 6.84 | Status text |
| error on error-soft / surface | 5.91 / 6.47 | Error text |
| line-strong on surface / canvas | 3.42 / 3.28 | Control boundaries (1.4.11) |
| line on surface | 1.30 | **Decoration only.** Never the sole boundary of a control |

Status is never colour alone. Every status carries its text label (spec §11.5: `Matched by ID`,
`Suggested pair`, `Needs your review`, `Unresolved`, `Identifier conflict`, `Quantity differs`).
Soft fills are for small regions such as a badge or a row, never whole cards.

## Typography

Families:

- `font-sans` (the body default): `"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif`.
  No downloaded fonts.
- `font-mono`: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`. Use it only for
  source IDs, raw cell values that need exact character shape, hashes and request IDs.
  `code/kbd/samp` get it automatically.
- Use `tabular-nums` for quantities, differences, counts, progress and any column of numbers.
  `.data-table` applies it to the whole table.

Role scale (`text-<role>`; each role carries its own line height, plus letter spacing and weight
where listed):

| Role | Size (≥768 / <768) | Line height | Tracking | Weight | Use |
| --- | --- | --- | --- | --- | --- |
| `display` | 44 / 34px | 1.12 | -0.02em | 600 | Editorial headline (Import intro) |
| `page` | 32 / 28px | 1.2 | -0.01em | 600 | Screen title |
| `section` | 22px | 1.3 | — | 600 | Section heading |
| `heading` | 18px | 1.35 | — | 600 | Panel / component heading |
| `body` | 16px | 1.55 | — | 400 | Running text (body default) |
| `dense` | 14px | 1.5 | — | 400 | Dense UI text, button labels |
| `table` | 14px | 1.45 | — | 400 | Table cells |
| `label` | 13px | 1.4 | — | 500 | Form labels, table headers, status labels |
| `caption` | 12px | 1.4 | — | 400 | Metadata only; never source values or status |

Weights are 400, 500 and 600. Use 700 only if a real hierarchy problem demands it. Negative
tracking is for `display` and `page` only. Do not use all-caps microtext as an information channel.
Tailwind's `text-sm/lg/xl` still exist because the current screens use them. Redesigned screens
move to the role classes.

## Spacing and layout

- The base unit is Tailwind's `--spacing: 4px` (`p-1` = 4px). Use the 8px rhythm (2, 4, 6, 8, 10,
  12, 16 → 8–64px), with 4px steps for fine alignment only.

| Token | Value | Utility example |
| --- | --- | --- |
| `--spacing-gutter` | 16px; 24px ≥768; 40px ≥1280 | `px-gutter` (page side padding) |
| `--container-content` | 1180px | `max-w-content` (page shell; Review may go wider later) |
| `--spacing-header` | 64px | `h-header` (app header) |
| `--spacing-panel` | 24px | `p-panel` |
| `--spacing-control` | 44px | `min-h-control` (buttons, primary touch targets) |
| `--spacing-control-dense` | 36px | `min-h-control-dense` (inputs and selects in dense forms) |
| `--radius-control` | 8px | `rounded-control` (buttons, inputs, badges) |
| `--radius-panel` | 12px | `rounded-panel` (panels, sheets, dialogs) |
| `--shadow-overlay` | two-layer, ≤8% ink | `shadow-overlay`, for popovers and dialogs **only** |

Borders are 1px. A bare `border` is a `line` hairline. Use `border-line-strong` when the border
identifies an interactive control. Surfaces are flat by default. Separate regions with a rule or
with spacing before reaching for a card, and never nest rounded panels.

Breakpoints are Tailwind's defaults: `md` 768, `lg` 1024, `xl` 1280. Spec §11.3–11.4 layout rules:

- **≥1280:** 64px header, record table with an evidence panel beside it (~60/40).
- **768–1279:** table plus a collapsible inspector or drawer.
- **<768:** `Records` / `Details` tabs. Action buttons stay reachable.
- **Overflow:** the page never scrolls horizontally. A dense table may scroll inside an explicit
  `overflow-x-auto` region. Never shrink numbers until they are unreadable.
- **Check every change** at 1440, 1024 and 390px.

## Interaction states (`globals.css` `@layer components`)

| State | `.btn` | `.btn-primary` | Inputs / selects / textarea |
| --- | --- | --- | --- |
| Default | surface fill, `line-strong` border, ink `dense` 500 text, 44px min height, 8px radius | accent fill, surface text | surface fill, `line-strong` border, 36px min height, 8px radius |
| Hover | light `line` tint | accent mixed 12% toward ink | (native) |
| Active | `line` fill | accent mixed 24% toward ink | (native) |
| Selected | `aria-current` or `aria-pressed="true"` → accent-soft fill, accent border and text | stays accent | — |
| Focus | global `:focus-visible`: 2px solid accent outline, 2px offset | same | same |
| Disabled | `:disabled` → 45% opacity, `not-allowed` cursor | same | canvas fill, muted text |
| Invalid | — | — | `aria-invalid="true"` → error border. Pair it with an error message linked by `aria-describedby` |
| Loading | `aria-busy="true"` → progress cursor. Change the label text to say what is happening, and only while real work is pending | same | — |

Rules:

- Selection is driven by ARIA state, not by extra classes, so the visual state and the
  accessible state cannot drift apart.
- Never remove a focus outline without an equally visible replacement. Do not rely on a
  border-colour change alone for focus.
- Disabled controls need a visible reason nearby (spec §11.5 DecisionControls).
- Transitions are colour-only, 140ms (`--duration-hover`). Panel entry and exit use 200ms
  (`--duration-panel`) when built. There is no `transition: all`.
- `prefers-reduced-motion: reduce` collapses every transition and animation to about 0 and
  disables smooth scroll. State changes must still be understandable without motion.

## Application shell (`web/src/ui/AccordApp.tsx`)

- **Header:** full-width `h-header` bar, `bg-surface`, bottom hairline. Left: the text brand
  `accord` + accent-coloured period (`text-section`). Right: `Start over` as a ghost button
  (`btn border-transparent bg-transparent`) with an inline `currentColor` reset icon. No other
  header content.
- **Content column:** one `mx-auto max-w-content px-gutter` wrapper below the header holds the
  workflow navigation, the error banner, the stage intro and `<main>`, separated by `gap-8`. On Import
  only, the intro and `<main>` share one card (`rounded-panel border bg-surface p-panel`, `gap-6`); the
  banner always stays outside it. It is the single place
  to widen the layout when Review needs it.
- **Workflow navigation:** `<nav aria-label="Workflow">` with an `<ol>` of four native buttons in a
  four-column grid (fits 390px without wrapping). Visible text is `01 Import` … `04 Export`, with the
  number in `text-caption tabular-nums text-muted`.

| Step state | Semantics | Presentation |
| --- | --- | --- |
| Current | `aria-current="step"` | 600 weight, 2px `accent` underline |
| Complete | `sr-only` ", complete" (name: `Import, complete`) | `success` check replaces the number, 2px `ink` underline |
| Available | enabled button | ink text, `line` underline |
| Unavailable | native `disabled` (not focusable, no dispatch) | `muted` text, `line` underline |

  Availability is `canEnterStage`. Completion is derived, never stored, and claimed only when state
  proves it: Import once both sources are loaded, Mapping once mappings are confirmed. Review and
  Export are never marked complete.
- **Stage intro:** the shell renders it from the `STAGES` table: an eyebrow (`text-label uppercase
  tracking-wide text-muted`, e.g. `02 / Mapping`), the page's one `<h1 id="stage-title" className="text-page">`
  written as a sentence ending in a period, and a lead in `text-muted`. A stage may override the eyebrow
  text (Import: `01 / Start a comparison`); the stepper label stays `Import`. `<main aria-labelledby="stage-title">`.
  Screens render no `h1`; their panels start at `h2`.
- **Error banner:** `role="alert"`, `rounded-panel border border-error bg-error-soft p-4`, a
  `text-heading text-error` title over the message in `text-dense`, and a `Dismiss` `.btn`. Import
  and analysis errors stay on their card or panel and never appear in the banner.
- **Destructive reset:** `Start over` asks with `window.confirm` only when a source is loaded or a
  reconciliation exists. Stage navigation never asks and never discards.

## Import (`web/src/ui/ImportScreen.tsx`)

- **Dropzones:** two per row from `md`, stacked below. Each is a `<label>` for a `sr-only` file input
  (`id="source-{A|B}-file"`), so a click anywhere opens the picker and the input keeps keyboard focus.
  Styling: `rounded-panel border border-dashed px-4 py-8`, centred, with a `currentColor` upload icon. The
  boundary is `line-strong` because the zone is a control. The ring is drawn on the label with
  `has-focus-visible:outline-2 outline-offset-2 outline-accent`.

| State | Second line | Caption (`text-caption text-muted`, `aria-live="polite"`) | Border |
| --- | --- | --- | --- |
| Empty | `Source A` | `Choose or drop a CSV` | `line-strong` |
| Dragging | — | — | `accent` + `bg-accent-soft` |
| Reading | — | `Reading file…` | — |
| Loaded | file name (`sr-only` "Source A: " prefix) | `Valid CSV · 4 records · 3 columns · 122 bytes` | `line-strong` |
| Error | `Source A` | `Choose or drop a CSV` | `error`, with a `role="alert"` message below |

- `Clear Source A` is a ghost `.btn` below a loaded zone, outside the label.
- **Footer:** `Or explore with sample data` as a quiet text button (`text-dense text-muted`) on the
  left. `Continue →` (`btn-primary`) on the right; while disabled it is a flat `bg-canvas` chip at full
  opacity, not the faded primary.
- There is no privacy paragraph on Import; see the open item in `docs/progress.md`.

## Accessibility requirements

WCAG 2.2 AA: use semantic tables, buttons and fieldsets. Every control has a visible label, and a
placeholder never stands in for one. Status always has text. Primary touch targets are at least
44px. The layout must survive 200% zoom and text resize. Long file names and product names wrap
or truncate with the full text reachable. Dialogs trap focus and return it to their trigger. Use
polite live regions for batch completion and `role="alert"` for errors that block an action.
Sticky headers must not hide focused controls.

## Examples

```tsx
// Panel with a heading and secondary text
<section className="rounded-panel border bg-surface p-panel">
  <h2 className="text-heading">Source A</h2>
  <p className="text-dense text-muted">12 rows · 4 columns</p>
</section>

// Status: text plus a soft fill, never colour alone
<span className="rounded-control bg-review-soft px-2 py-0.5 text-label text-review">Needs your review</span>

// Field with an error
<input id="qty" aria-invalid aria-describedby="qty-error" />
<p id="qty-error" className="text-dense text-error">This value is not a supported decimal.</p>

// Numbers
<td className="tabular-nums">-1</td>
<code className="text-dense">P03</code>
```

## Decisions recorded

- **`error`, not `danger`.** The spec and the phase prompt say `error`, and the skill's draft
  reference said `danger`. The skill now uses `error`.
- **`#5F646D` / `#DFE2E7`, not the earlier exploration values `#60646E` / `#DEDFE3`.** The spec
  values are canonical, and no near-duplicates are kept.
- **`line-strong` added.** The spec `line` is 1.30:1 on white, which fails the 3:1 control
  boundary rule. `#868B94` is the lightest neutral that passes on both canvas and surface.
- **Helvetica stack over Geist.** Geist was loaded but never rendered (body forced Arial). It was
  removed, so the build no longer downloads fonts.
- **Primary is accent.** The starter `.btn-primary` was ink-filled. Primary is now the accent,
  per the direction.
- **Light only.** The starter dark-mode block was removed (v1 scope).
