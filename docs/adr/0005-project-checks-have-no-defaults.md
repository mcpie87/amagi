# Project checks have no defaults, and an undeclared repository is never claimed

Each repository declares its format, lint and test commands in its own `.amagi/config.toml`, each as a non-empty shell command. A key that is absent or empty blocks claiming in that repository and sends a notification. Amagi ships no defaults, does not detect a task runner, and does not accept checks from the global config.

The old `just fmt`/`just lint` defaults did not fail safely. In WaveTools (no justfile) and nixOS (no `lint` recipe), the runner sent the command's error back to the agent as a failing check, and the agent "fixed" it by writing its own justfile recipes, which were then committed into task PRs. When a check cannot run, that is a configuration error only a human can resolve, so amagi stops before any agent work. For the same reason, format and lint run as a preflight on the untouched worktree: a command that cannot run, or a base that fails it, parks the repository instead of becoming an agent's problem.

## Considered Options

- Requiring a task runner (justfile/Makefile) with fixed recipe names: forces a file into repositories we may not own, and invites the same invention.
- Autodetecting from justfile, package.json or Makefile: guesses the formatter and the package manager, and makes a wrong guess look intentional.
