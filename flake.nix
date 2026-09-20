{
  description = "amagi: agent task orchestrator";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      # Toolchain amagi itself needs to build and test.
      requiredNames = [
        "bun"
        # biome comes from the lockfile via `bun x`, so every machine lints identically
        "just"
        "git"
        "jq"
      ];

      # Tools amagi *drives* at runtime. Attribute names drift between nixpkgs
      # revisions and some are not packaged at all, so resolve them leniently
      # and report what is missing instead of failing evaluation.
      optionalNames = [
        "gh"
        "tea"
        "beads"
        "claude-code"
        "codex"
        "opencode"
        "libnotify"
        "fzf"
      ];

      # Some harnesses ship under an unfree license. Allow exactly those rather
      # than opening the whole package set.
      unfreeAllowed = [
        "claude-code"
        "codex"
      ];

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) unfreeAllowed;
        };

      forAllSystems = f: lib.genAttrs systems (system: f (pkgsFor system));

      present = pkgs: names: builtins.filter (n: (pkgs.${n} or null) != null) names;
      absent = pkgs: names: builtins.filter (n: (pkgs.${n} or null) == null) names;
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          gaps = absent pkgs optionalNames;
          resolved = map (n: pkgs.${n}) (present pkgs (requiredNames ++ optionalNames));
        in
        {
          default = pkgs.mkShell {
            packages = resolved;
            shellHook = ''
              export AMAGI_DEV=1
              ${lib.optionalString (gaps != [ ]) ''
                echo "amagi: not packaged in this nixpkgs, provide yourself if needed: ${lib.concatStringsSep " " gaps}" >&2
              ''}
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree or pkgs.nixfmt-rfc-style or pkgs.nixpkgs-fmt);
    };
}
