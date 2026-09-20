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

status:
    bun run packages/cli/src/index.ts status
