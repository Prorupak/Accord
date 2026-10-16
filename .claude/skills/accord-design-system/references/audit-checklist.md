# Accord UI audit checklist

For each modified UI area, assess and report only what was actually checked.

1. **Tokens:** no hard-coded repeated palette values, no competing near-duplicate colors, no new unexplained font sizes/radii/shadows.
2. **Hierarchy:** a user can identify the current stage, primary action, section title, content and supporting metadata without relying on color.
3. **Content:** labels describe real input, selected fields, actual errors or truthful AI state. No fictional status, confidence or sample result.
4. **Typography:** sensible wrapping and overflow, correct heading hierarchy, tabular numeric differences, monospace restricted to IDs/technical data.
5. **Focus:** complete keyboard tab sequence, visible `:focus-visible`, no clipped/obscured rings, accessible controls and dialogs.
6. **Contrast:** check actual foreground/background combinations and non-text component borders; don't assume token choices automatically pass every state.
7. **Responsive:** 1440 / 1024 / 390px screenshots or browser inspection; no unintended page scroll, trapped controls or unreadable dense values.
8. **Motion:** no movement that changes information meaning or disrupts selection; reduced motion checked where transitions exist.
9. **Architecture:** no changes to domain matching, reducer, AI request payloads, API, proposals, export snapshot rules or source-record handling.
10. **Regression:** project tests, typecheck, lint and build run; existing Playwright workflows when affected; report any unavailable commands as not run.

When finishing, report: affected surfaces, tokens reused/created, observed visual checks, test results, and known gaps. Don't claim browser or accessibility verification from unit tests alone.
