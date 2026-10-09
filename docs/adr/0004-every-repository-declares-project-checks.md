# Every repository declares its project checks

Each repository config must declare non-empty formatter, lint, and test
commands. These checks describe repository-specific tooling, so defaults in
the shared config cannot be assumed to exist in every repository. A global
`[checks]` table is rejected so its commands cannot leak into repository
checks. A missing recipe must be caught while loading config, rather than
passed to an agent as a failed check and prompting it to invent project tooling.

The runner executes formatting, lint, and tests in that order, followed by
optional additional commands. Formatter and lint are not silently disabled
when absent. Readiness diagnosis reports invalid config before the repository
can be dispatched.
