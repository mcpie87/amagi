---
match: ["**/*.sh", "**/*.bash", "**/*.zsh"]
---
# Shell

- Check quoting and word splitting for every expansion, especially paths, patterns, and values supplied by callers.
- Verify exit status handling in pipelines, command substitutions, conditionals, and cleanup traps. A pipeline may hide an earlier failure.
- Check unset and empty variables, glob expansion, whitespace, and filenames beginning with `-`.
- Review temporary files, lock files, traps, and background processes for safe cleanup on success, failure, and signals.
- Ensure external input is not evaluated as shell code and that commands use safe argument boundaries rather than interpolated command strings.
- Check destructive commands, privilege changes, and working-directory assumptions against the actual call site.
