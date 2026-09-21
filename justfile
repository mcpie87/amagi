default: check

install:
    bun install

check: lint typecheck build test

lint:
    bun x biome check .

fmt:
    bun x biome check --write .

typecheck:
    bun x tsc --noEmit

build:
    cd packages/dashboard && bun run build

test:
    bun test

# Verify a clean-room install (fresh node_modules strictly from the lockfile)
# still builds the dashboard. Catches a dep added to package.json without a
# bun.lock update, or an import that only resolves because a stale node_modules
# happens to have the package. Run as part of merge validation, not local dev.
fresh-check:
    rm -rf node_modules packages/*/node_modules
    bun install --frozen-lockfile
    bun run --filter @amagi/dashboard build

status:
    bun run packages/cli/src/index.ts status
