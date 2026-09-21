default: check

install:
    bun install

check: lint typecheck test

lint:
    bun x biome check .

fmt:
    bun x biome check --write .

typecheck:
    bun x tsc --noEmit

test:
    bun test

fresh-check:
    rm -rf node_modules packages/*/node_modules
    bun install --frozen-lockfile
    bun run --cwd packages/dashboard build

status:
    bun run packages/cli/src/index.ts status
