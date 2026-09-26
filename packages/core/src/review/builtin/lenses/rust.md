---
match: ["**/*.rs", "**/Cargo.toml", "**/Cargo.lock"]
---
# Rust

- Check `Result` and `Option` handling for discarded failures, panic paths, and assumptions that inputs are present or valid.
- Review ownership, borrowing, and interior mutability around shared state; safe code can still have logical races or lock-order deadlocks.
- Check async task cancellation, spawned task lifetime, lock guards held across `.await`, and errors lost from detached tasks.
- Verify boundary conversions, integer overflow behavior, UTF-8 assumptions, and whether lossy conversions are acceptable.
- Review `unsafe` blocks against their invariants and callers; ensure safety comments still describe the actual code.
- Check feature flags and target-specific code so the change works in the configurations the repository supports.
