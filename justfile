# Run all checks (lint, typecheck, build, test)
default: check

# Show what each recipe does and when to run it
help:
    just --list

# Install dependencies (run first after cloning)
install:
    bun install

# Run all checks: lint, typecheck, build, test
check: lint typecheck build test

# Lint and format-check the code
lint:
    bun x biome check .

# Auto-fix formatting and lint issues
fmt:
    bun x biome check --write .

# Type-check the TypeScript code without emitting
typecheck:
    bun x tsc --noEmit

# Build the dashboard package
build:
    cd packages/dashboard && bun run build

# serve.test.ts fetches real files under packages/dashboard/dist, which is
# gitignored build output, not checked-in source.
# Run the tests (builds dashboard dist first)
test: build-dashboard
    bun test

# Build dashboard dist (needed before test)
build-dashboard:
    bun run --filter @amagi/dashboard build

# Verify a clean-room install (fresh node_modules strictly from the lockfile)
# still builds the dashboard. Catches a dep added to package.json without a
# bun.lock update, or an import that only resolves because a stale node_modules
# happens to have the package. Run as part of merge validation, not local dev.
fresh-check:
    rm -rf node_modules packages/*/node_modules
    bun install --frozen-lockfile
    bun run --filter @amagi/dashboard build

# Show the bot's status
status:
    bun run packages/cli/src/index.ts status

# Serve the API and dashboard (dev, watch mode)
serve:
    bun serve

# Run the bot. Pin the harness/model/effort to skip the interactive picker:
# `just run -- --harness claude --model <model>` or `just run --harness claude`.
[arg('model', long='model', help='model to pass to the harness')]
[arg('effort', long='effort', help='reasoning effort to pass to the harness')]
[arg('harness', long='harness', help='harness.definitions name or a kind (claude/codex/opencode)')]
run harness='' model='' effort='' *extra:
    bun run packages/cli/src/index.ts run \
        {{ if harness != '' { '--harness ' + harness } else { '' } }} \
        {{ if model != '' { '--model ' + model } else { '' } }} \
        {{ if effort != '' { '--effort ' + effort } else { '' } }} \
        {{ extra }}

# Reply to mentions directed at the bot
respond-to-mentions:
    bun run packages/cli/src/index.ts respond-to-mentions

# Check PRs the bot is involved in
check-prs:
    bun run packages/cli/src/index.ts check-prs

# Interactively draft a task with the picked agent, create it, then run it
new:
    bun run packages/cli/src/index.ts new
