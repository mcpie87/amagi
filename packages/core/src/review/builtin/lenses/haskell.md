---
match: ["**/*.hs", "**/*.cabal", "**/package.yaml", "**/stack.yaml"]
---
# Haskell

- Check partial functions and incomplete matches on values that can be empty or gain constructors; trace whether inputs can reach them.
- Review `error`, `undefined`, unchecked reads, and unsafe coercions at library and user-input boundaries.
- Check strictness in accumulators and fields for space leaks, and avoid forcing whole or unbounded structures in streaming paths.
- Trace effects and error channels through the call graph; ensure acquired resources use bracketed cleanup and broad exception handlers preserve asynchronous cancellation.
- Follow local conventions for `Text` versus `String`, signatures, newtypes, and instance ownership.
- Verify new modules are included in package metadata, dependencies fit the pinned resolver, and warning suppressions do not hide new problems.
