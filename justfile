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

# serve.test.ts fetches real files under packages/dashboard/dist, which is
# gitignored build output, not checked-in source.
test: build-dashboard
    bun test

build-dashboard:
    bun run --filter @amagi/dashboard build

# Clean-room install strictly from the lockfile, then build the dashboard.
# Catches a dep added to package.json without a bun.lock update, or an import
# that only resolves because a stale node_modules happens to have the package.
fresh-check:
    rm -rf node_modules packages/*/node_modules
    bun install --frozen-lockfile
    bun run --filter @amagi/dashboard build

status:
    bun run packages/cli/src/index.ts status

run:
    bun run packages/cli/src/index.ts run
