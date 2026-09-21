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

      # Workspaces the compiled `amagi` binary actually needs at build time.
      # The dashboard is a separate (Vite) build and isn't bundled by
      # `bun build --compile`, so it's excluded from the fetched dependency
      # set below.
      runtimeWorkspaces = [
        "cli"
        "core"
        "server"
      ];

      # Only the files bun's installer reads to resolve dependencies. Keeping
      # this narrow means editing application source never invalidates the
      # fixed-output derivation below, so it never re-hits the registry.
      # `self` is a flake ref rather than a real path, so the copy is done
      # with `cp` (which accepts store-path strings) instead of `lib.fileset`.
      mkNodeModulesSrc =
        pkgs:
        pkgs.runCommand "amagi-node-modules-src" { } (
          ''
            mkdir -p $out
            cp ${self}/package.json ${self}/bun.lock ${self}/bunfig.toml $out/
          ''
          + lib.concatMapStrings (name: ''
            mkdir -p $out/packages/${name}
            cp ${self}/packages/${name}/package.json $out/packages/${name}/
          '') runtimeWorkspaces
        );

      # `bun install` needs the network, which a normal derivation can't have
      # under the Nix sandbox. Fetching into a fixed-output derivation keyed
      # on the lockfile sidesteps that: Nix allows network access precisely
      # because the output is content-addressed, so any drift is caught by a
      # hash mismatch rather than trusted silently.
      mkNodeModules =
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
          pname = "amagi-node-modules";
          version = "0.0.0";
          src = mkNodeModulesSrc pkgs;
          nativeBuildInputs = [
            pkgs.bun
            pkgs.cacert
          ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"
            bun install --frozen-lockfile --production --ignore-scripts
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r node_modules "$out/node_modules"
            for name in ${lib.concatStringsSep " " runtimeWorkspaces}; do
              mkdir -p "$out/packages/$name"
              cp -r "packages/$name/node_modules" "$out/packages/$name/node_modules"
            done
            runHook postInstall
          '';
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-QDrgcBBXf4BXugGHroeLLWaY8Qkoxp/g6Kp0s4RgWFA=";
        };

      # `bun build --compile` bundles every import into one self-contained
      # native executable, so nothing under node_modules needs to ship (or
      # exist) alongside the installed binary.
      mkAmagi =
        pkgs:
        let
          nodeModules = mkNodeModules pkgs;
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "amagi";
          version = "0.0.0";
          src = self;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"
            cp -r "${nodeModules}/node_modules" ./node_modules
            for name in ${lib.concatStringsSep " " runtimeWorkspaces}; do
              cp -r "${nodeModules}/packages/$name/node_modules" "packages/$name/node_modules"
            done
            chmod -R u+w node_modules packages/*/node_modules
            bun build --compile --outfile amagi packages/cli/src/index.ts
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out/bin"
            install -m755 amagi "$out/bin/amagi"
            runHook postInstall
          '';
          meta = {
            description = "amagi: agent task orchestrator";
            mainProgram = "amagi";
            platforms = systems;
          };
        };
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

      packages = forAllSystems (pkgs: {
        default = mkAmagi pkgs;
        amagi = mkAmagi pkgs;
      });

      # Stub: installs the binary and, if given settings, renders
      # ~/.config/amagi/config.toml. Per-repo `.amagi/config.toml` is still
      # the project's own job, not home-manager's.
      homeManagerModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.programs.amagi;
          tomlFormat = pkgs.formats.toml { };
        in
        {
          options.programs.amagi = {
            enable = lib.mkEnableOption "amagi, the agent task orchestrator";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.default;
              defaultText = lib.literalExpression "amagi.packages.<system>.default";
              description = "The amagi package to install.";
            };

            settings = lib.mkOption {
              type = tomlFormat.type;
              default = { };
              example = lib.literalExpression ''
                {
                  tracker.kind = "beads";
                  forge = { kind = "github"; remote = "origin"; };
                }
              '';
              description = ''
                Settings rendered to `~/.config/amagi/config.toml`. Keys
                mirror amagi's own config schema (see the project README);
                unset keys keep amagi's built-in defaults.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ];

            xdg.configFile."amagi/config.toml" = lib.mkIf (cfg.settings != { }) {
              source = tomlFormat.generate "amagi-config.toml" cfg.settings;
            };
          };
        };

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree or pkgs.nixfmt-rfc-style or pkgs.nixpkgs-fmt);
    };
}
