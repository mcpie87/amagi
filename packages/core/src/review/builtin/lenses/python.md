---
match: ["**/*.py", "**/pyproject.toml", "**/requirements*.txt", "**/Pipfile", "**/tox.ini"]
---
# Python

- Check mutable default arguments, late-bound closures, accidental shared state, and broad exception handling that hides failures or interrupts cancellation.
- Verify file, socket, lock, and transaction cleanup on every exit path; prefer context managers where the project does.
- Check `None`, empty collections, numeric boundaries, timezone-aware dates, and assumptions hidden by truthiness.
- Review dynamic imports, deserialization, subprocess invocation, and path construction at trust boundaries.
- Check generator exhaustion, eager materialization of large iterables, and repeated database or network work inside loops.
- Follow local typing and test conventions. A type annotation is not runtime validation for external input.
