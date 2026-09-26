---
match: ["**/*.rb", "**/Gemfile", "**/Gemfile.lock", "**/*.gemspec"]
---
# Ruby

- Check nil and empty values, truthiness assumptions, mutable default objects, and accidental mutation of shared inputs.
- Review exception rescue scope: broad rescue can hide defects, and ensure cleanup runs without masking the original exception.
- Trace database queries in loops, lazy relations that are evaluated repeatedly, and writes that need a transaction.
- Check mass assignment and parameter filtering, authorization at the resource, shell arguments, and dynamically constructed paths.
- Verify blocks and callbacks run at the expected time, especially around transactions, retries, and asynchronous jobs.
- Follow local conventions for metaprogramming and dependencies; inspect generated behavior at changed call sites.
