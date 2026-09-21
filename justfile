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

# Show the bot's status
status:
    bun run packages/cli/src/index.ts status

# Run the bot
run:
    bun run packages/cli/src/index.ts run

# Reply to mentions directed at the bot
respond-to-mentions:
    bun run packages/cli/src/index.ts respond-to-mentions

# Check PRs the bot is involved in
check-prs:
    bun run packages/cli/src/index.ts check-prs
