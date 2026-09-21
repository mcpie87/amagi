default: check

install:
    bun install

check: lint typecheck build test

# Alias used by the orchestrator's check step.
fresh-check: check

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

status:
    bun run packages/cli/src/index.ts status
