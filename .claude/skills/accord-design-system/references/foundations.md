# Accord foundation contract — Phase 04-I/01

This is background for the `accord-design-system` skill. The **runtime source of truth** is the `@theme static` block in `web/app/globals.css`, documented in `docs/ui-design-system.md`. Read that document first; where this file differs, the document and `globals.css` win.

## 1. Palette: canonical values from the implementation specification

| Semantic role | Token naming recommendation | Hex | Usage |
| --- | --- | --- | --- |
| Canvas | `--color-canvas` | `#FAFAFA` | App body background |
| Surface | `--color-surface` | `#FFFFFF` | Inputs, tables, sheets, elevated zones |
| Ink | `--color-ink` | `#17191D` | Headings, primary content |
| Muted ink | `--color-muted` | `#5F646D` | Secondary text |
| Rule / border | `--color-line` | `#DFE2E7` | Decorative hairlines only (1.30:1 on white) |
| Control border | `--color-line-strong` | `#868B94` | Button/input boundaries (≥3:1, WCAG 1.4.11) |
| Primary accent | `--color-accent` | `#244BEA` | Primary actions, active state, focus |
| Accent soft | `--color-accent-soft` | `#EEF2FF` | Selected background when not overused |
| Success | `--color-success` | `#166534` | True success / matched state |
| Success soft | `--color-success-soft` | `#F0FDF4` | Optional subtle status background |
| Needs review | `--color-review` | `#92400E` | User action pending / caution |
| Review soft | `--color-review-soft` | `#FFFBEB` | Optional subtle status background |
| Error | `--color-error` | `#B91C1C` | Errors and blocked conflicts |
| Error soft | `--color-error-soft` | `#FEF2F2` | Optional subtle status background |

Resolved in `docs/ui-design-system.md`: the spec values `#5F646D` / `#DFE2E7` are canonical (not the exploration values `#60646E` / `#DEDFE3`), the error role is named `error` (not `danger`), and `line-strong` was added for control boundaries.

Status is never color-only. Avoid decorative semantic fills across entire cards. Confirm text/background contrast in actual rendered pairs.

## 2. Typography — Phase 04 design decisions

- Body stack (implemented; Geist removed): `Helvetica Neue`, `Helvetica`, `Arial`, system sans fallbacks; do not download proprietary fonts or introduce new licensing burdens.
- Monospace: platform-safe `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` for source IDs and technical values only.
- Suggested *role scale* (desktop / mobile where distinct): display 44/34px; page title 32/28px; section heading 22/20px; component heading 18px; body 16px; dense body 14px; table 13–14px; label 13px; caption/meta 12px. Keep editable tokens, not scattered magic pixels.
- Line height: display ~1.12–1.2, headings ~1.2–1.3, text ~1.5–1.6. Adjust after real visual inspection.
- Weights: 400 regular, 500 medium, 600 semibold, 700 only when hierarchy requires it.
- Slight negative letter spacing may be used for display headings, not tables/body.
- Preserve native font scaling/zoom; do not use `transform: scale()` to make text smaller.
- Apply `font-variant-numeric: tabular-nums` to columns, counts, IDs with regular numeric shape, deltas and progress indicators.

## 3. Spacing and layout — Phase 04 design decisions

- Base unit: 4px. Spacing set for common use: 4, 8, 12, 16, 24, 32, 40, 48, 64px. Prefer 8px rhythm with 4px fine alignment.
- Outer padding: desktop 40px, tablet 24px, mobile 16px (prefer responsive tokens over repeated hardcoding).
- Comfortable content max width: approximately 1180px for onboarding/Mapping; Review may use full available desktop width.
- App header: 64px. Touch controls: minimum 44px for primary interactive targets.
- Borders: 1px hairlines. `--radius-control: 8px`; `--radius-panel: 12px`; smaller radius only when component semantics require it.
- Shadows: avoid by default; reserve subtle elevation for floating popovers/dialogs.

## 4. Interaction tokens — Phase 04 design decisions

- Focus ring: visible 2px blue outline with 2px offset on keyboard focus; verify contrast against light and selected backgrounds. A neutral separation ring may be necessary on accented surfaces.
- Don't remove outlines from native controls without an equivalent replacement. Don't rely solely on border-color changes for focus.
- States to style consistently: default, hover, active, focus-visible, disabled, loading (only for real work), invalid, selected.
- Typical hover transition: 120–160ms; surface reveal 160–220ms where appropriate. No global transition on all properties.
- Under `prefers-reduced-motion: reduce`, disable nonessential transforms/movement and keep state changes understandable without animation.
- Provide clear interactive target sizes, error labels/help text, and preserved focus after changes.

## 5. Surface-specific usage

- **Import:** spacious, expressive heading, clean symmetrical source regions, validation metadata, native picker support, real errors.
- **Mapping:** compact labeled field rows, readable select boxes, actual sample values, clear optionality and confirmation of quantity-unit assertions.
- **Review (later phase):** denser 13–14px table, source columns and values visible, stable row positions, readable status text, evidence-first inspector.
- **Export (later phase):** clear row accounting and artifact list, no fake success copy; downloads invalidated by authoritative domain state.

## 6. Tailwind compatibility guidance

- Determine installed Tailwind version before modifying CSS or config.
- For v4, semantic `@theme` color namespace creates utility classes, and `@theme inline` is useful when mapping another variable. Preserve existing imports and layer ordering. Do not combine `@theme` with a competing Tailwind v3 config source unnecessarily.
- For v3, extend the existing `tailwind.config.*` palette/fonts/radii; keep CSS variables as canonical values if that's already the approach.
- For plain CSS or existing shadcn variables, use semantic `var(--...)` mappings; retain compatibility with existing components.
- Avoid `@apply` proliferation or broad global selectors changing every button/table indiscriminately. Prefer carefully scoped base element rules and existing utilities.
- Avoid duplicate nearly identical role names (e.g. `primary`, `brand`, `blue`, `accent` all representing the same color); settle on one vocabulary.

## 7. Accessibility gate

- Aim for WCAG 2.2 AA: normal text 4.5:1 contrast, large text 3:1; required control boundaries/states 3:1 when applicable.
- Visible keyboard focus and controls not hidden by sticky navigation.
- Check 200% browser zoom, text resize, long filenames, long product names, 390px width and keyboard tab sequence.
- Do not rely on placeholders for labels or icons for status meaning.
- Plain text labels accompany semantic colors for matched, suggested, conflicted, invalid, pending and failed states.
