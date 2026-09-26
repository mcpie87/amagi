---
match: ["**/*.tsx", "**/*.jsx"]
---
# React

- Check hooks for stale closures, incorrect dependencies, missing cleanup, and effects used to derive state that can be computed during render.
- Verify async requests cannot update obsolete state, and overlapping requests cannot let an older result overwrite a newer one.
- Check server-state cache keys include every input and mutations refresh affected views.
- Review list keys when items reorder, controlled inputs when values may start absent, and conditional rendering of numeric values.
- Check error and loading paths remain visible to users, and retries do not repeat non-idempotent actions.
- Validate untrusted markup, URLs, and browser-exposed configuration. UI visibility is not authorization.
- For new interactive elements, check keyboard behavior, labels, accessible names, and focus handling.
