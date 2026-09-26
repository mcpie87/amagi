---
match: ["**/*.py", "**/*.java", "**/*.kt", "**/*.go", "**/*.rs", "**/*.rb", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.yaml", "**/*.yml", "**/*.graphql", "**/*.proto", "**/openapi.*"]
---
# API contract across server and client

Run this lens when the change touches both sides of an API boundary. If only one side changed, trace compatibility with the unchanged deployed side and report only a concrete break.

- Map changed routes or operations to every changed and existing caller. Compare method, path, request fields, response fields, nullability, enums, status codes, errors, pagination, and authorization.
- Check field renames, requiredness, representation, casing, date/time formats, and decimal or large integer encoding at the actual serialization boundary.
- Verify generated schemas or clients are regenerated when the repository relies on them; check hand-maintained types against runtime payloads.
- Check upload encoding, size/type limits, validation behavior, and user-visible handling of new failure responses.
- Review rolling deployment compatibility: identify which version must deploy first and whether old callers or servers remain supported.
- Cite both sides of a broken pairing. If the changed areas do not share an API boundary, say that the cross-cutting check found no coupling.
