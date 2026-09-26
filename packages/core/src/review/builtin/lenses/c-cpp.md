---
match: ["**/*.c", "**/*.h", "**/*.cc", "**/*.hh", "**/*.cpp", "**/*.hpp", "**/*.cxx", "**/*.hxx"]
---
# C and C++

- Check buffer sizes, integer conversions and overflow, pointer validity, bounds, and string termination at changed boundaries.
- Trace allocation and ownership through all exits. Look for leaks, double frees, use-after-free, invalidated references, and mismatched allocation/deallocation.
- Review aliasing, object lifetime, iterator invalidation, and concurrency around shared state; check that lock scope protects the full invariant.
- In C++, inspect move/copy behavior, exception safety, RAII ownership, and virtual destruction through base pointers.
- In C, check return codes, partial reads/writes, errno handling, and cleanup after partially initialized state.
- Review changed `unsafe` system interfaces and serialization for alignment, representation, and trust-boundary validation.
