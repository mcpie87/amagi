---
match: ["**/*.go", "**/go.mod", "**/go.sum"]
---
# Go

- Check every returned error and ensure wrapping preserves useful context. Verify cleanup errors do not hide the primary failure.
- Trace `context.Context` through I/O and goroutines; check cancellation, deadlines, goroutine exit, and channel close ownership.
- Look for races on shared maps or fields, unsynchronized check-then-act logic, and loop-variable capture in deferred or asynchronous work.
- Check nil interfaces and pointers, zero values, slice aliasing, map mutation, and integer overflow at changed boundaries.
- Verify locks are released on all paths and are not held across blocking work unnecessarily.
- Check `defer` placement in loops and resource ownership. Follow the repository's package and test conventions.
