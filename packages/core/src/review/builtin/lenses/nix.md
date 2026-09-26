---
match: ["**/*.nix", "**/flake.lock"]
---
# Nix and NixOS

- Check module arguments, option declarations and reads, merge priorities, and whether enable options actually gate their configuration.
- Trace recursive references and laziness around changed definitions; verify values have the intended string, path, or derivation type.
- Check that secrets do not enter derivations or the store, fetches are pinned, and runtime tools have a reliable path.
- Review activation scripts for idempotence, safe ownership, quoting, ordering, and behavior when rerun or partially completed.
- Verify services have the dependencies and restart behavior they need, and that firewall exposure is intentional.
- Check new flake inputs follow repository pinning conventions and lockfile changes are related to the change.
- Infer evaluation and validation expectations from repository instructions and existing CI. Do not add operator-specific machine or verification commands.
