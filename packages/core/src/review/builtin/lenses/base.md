# Language-agnostic baseline

Apply to every changed file. Follow established repository patterns; these are prompts to investigate, not automatic findings.

## Correctness and safety

- Check boundary values, empty or missing data, operator precedence, state transitions, and error paths.
- Trace resource ownership and cleanup across success, error, cancellation, and retry paths.
- Look for races, check-then-act assumptions, and shared mutable state.
- When changed data crosses a trust boundary, check validation, authorization at the resource, injection, path handling, and secret exposure.
- Check compatibility for persisted data, public interfaces, and rolling deployments where relevant.

## Change hygiene and smells

- Flag unrelated edits that obscure this change, dead or half-finished code, and configuration or documentation drift caused by the change.
- Treat smells as evidence prompts, never rules: unexplained duplication, unclear names, primitive domain values, scattered conditionals, overlong functions made worse, forwarding-only layers, or abstractions without a current use.
- New risky branching logic should have behavior-focused coverage consistent with the repository's practice.

## Do not report

- Issues a configured formatter, linter, or type checker will identify by itself.
- Style preferences that conflict with local conventions.
- Generic requests for more types, tests, or documentation without a concrete defect and location.
