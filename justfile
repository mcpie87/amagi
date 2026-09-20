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

status:
    bun run packages/cli/src/index.ts status
