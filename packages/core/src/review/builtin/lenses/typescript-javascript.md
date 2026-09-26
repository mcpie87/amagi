---
match: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.mts", "**/*.cts"]
---
# TypeScript and JavaScript

- Check promise rejection and cancellation paths, unhandled async work, stale closures, and races between overlapping requests.
- Verify effect dependencies and cleanup; state derived from props or other state usually belongs in render or a selector.
- Check list keys when items reorder, controlled inputs when values can be absent, and numeric `&&` rendering that can show zero.
- Treat unchecked casts, `any`, non-null assertions, and suppressed type errors at external-data boundaries as validation gaps. Match optional and nullable fields to actual runtime values.
- Check cache keys include every input and successful mutations invalidate affected data. Avoid retries for non-idempotent operations.
- Ensure user-provided content is escaped or sanitized, authorization is enforced server-side, and secrets are not bundled into browser code.
- For interactive UI changes, check keyboard access, labels, focus behavior, and accessible names.
