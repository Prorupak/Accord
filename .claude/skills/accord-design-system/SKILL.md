---
name: accord-design-system
description: Apply and audit Accord's editorial UI design system whenever creating, changing, reviewing, or refactoring the application's React components, layout, typography, colors, spacing, borders, focus states, responsive behavior, or visual styles. Use for all Accord UI work in Phase 04 and later; preserve existing reconciliation and AI behavior.
---

# Accord design system — persistent visual contract

Use this project-scoped skill whenever working on the visual/UI layer of Accord. It is a **consistency guard**, not a request to redesign the whole application.

## Priority and context

1. Follow the user's current task and applicable `AGENTS.md` / `CLAUDE.md`.
2. Read `docs/ui-design-system.md` (canonical; tokens live only in the `@theme static` block of `web/app/globals.css`) and `accord-implementation-spec.md` §11.
3. Read [references/foundations.md](references/foundations.md) for approved foundation values and usage rules.
4. Read [references/audit-checklist.md](references/audit-checklist.md) before completing UI work.
5. Inspect actual CSS/Tailwind configuration and existing shared UI patterns before editing. Never assume the repo uses a particular Tailwind major version.
6. If a source documents a different value, identify the conflict and preserve the already adopted canonical token until the user explicitly changes it. Avoid silently introducing a competing design language.

## Design intent

**Editorial precision / quiet intelligence.** The application should be calm, credible, data-first, highly legible and intentional. Borrow restraint from Rupak's portfolio, but optimize for a dense, accurate comparison workspace.

- Off-white canvas, white surfaces, near-black ink, restrained blue accent, subtle neutral rules.
- Typography and spacing establish hierarchy; colored cards and decoration do not.
- Original records and evidence outrank AI explanations.
- A suggested match is never presented as verified or accepted.
- Product quantity differences and policy conflicts use separate, readable statuses.
- Light theme for v1; do not introduce dark mode unasked.

## Mandatory implementation behavior

1. **Use semantic tokens:** Colors, radii, layout widths, type roles, spacing and focus treatments come from the canonical design-token source. Never add a parallel palette or arbitrary repeated hex/radius values in components.
2. **Preserve theme integration:** With Tailwind v4, map named utilities via `@theme`/`@theme inline` where suitable; with Tailwind v3, extend the existing config; with plain CSS, use variables. Maintain exactly one authoritative source of design values.
3. **Typography discipline:** Use the approved neutral sans stack; monospace only for IDs, raw code/technical values. Keep tables readable and numbers tabular; avoid gratuitous all-caps microtext or tiny labels.
4. **Visual restraint:** Hairline separators, mostly flat surfaces, sparse shadows only for elevated content, 8px control radius and 12px panel radius. Don't introduce gradients, glow, glassmorphism, animated blobs, rounded-card nesting or unnecessary icons.
5. **Accessibility:** Visible `:focus-visible` treatment for all interactive controls, useful labels, semantic markup, text alongside status color, 44px touch targets where appropriate, tested contrast, 200% zoom support, and reduced-motion handling for transitions. Do not remove native focus indication without replacing it.
6. **Responsive design:** Verify desktop (1440px), tablet (1024px) and mobile (390px). Dense tables may scroll inside an explicitly bounded region, but page overflow and obscured controls are not acceptable.
7. **Small diffs:** Reuse existing components and business logic. No duplicate hooks or state stores; do not change `web/src/domain/`, `web/src/workflow/`, `web/src/analysis/`, `api/`, `useExportArtifacts` or their contracts for visual styling alone.
8. **Honest states:** Use real import, mapping, suggestion, uncertainty, failure, cancellation and export states. No fake badges, confidence percentages, model traces or invented sample results.
9. **Don't broaden scope:** Foundations (04-I/01) and the application shell (04-I/02, see "Application shell" in `docs/ui-design-system.md`) are done; reuse the shell's header, navigation states, screen-owned `h1` and error banner rather than re-creating them. Each task changes only the requested surface.

## Routine for every UI task

1. Inspect affected components, canonical tokens and relevant requirements.
2. State which semantic roles/tokens are being used; extend a token only when it represents a genuinely reusable role.
3. Implement minimal changes, keeping domain behavior untouched.
4. Check keyboard interaction, focus visibility, contrast, number alignment, text wrapping, 1440/1024/390 widths and reduced motion.
5. Run project validation: relevant tests, typecheck, lint and build. Report commands actually executed.
6. Summarize files changed, reused/added tokens, visual checks performed, limitations and any intentional departures from the system.

If user asks for a novel visual treatment contrary to this system, explicitly surface the tradeoff rather than silently abandoning the design language.
