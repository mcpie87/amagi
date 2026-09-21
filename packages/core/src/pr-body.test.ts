import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import { backtickCodeRefs, changesSinceBase, formatPrBody } from './pr-body.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

const TASK: TrackerTask = {
  id: 'am-1',
  title: 'Add a greeting file',
  description: 'Write hello.txt',
  status: 'in_progress',
  priority: 1,
  type: 'task',
  url: null,
}

describe('changesSinceBase', () => {
  test('prefers the origin base ref when it exists', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('rev-parse')) return ok('')
      if (c.includes('--numstat')) return ok('1\t0\thello.txt\n-\t-\timage.png\n')
      return undefined
    })
    const changes = await changesSinceBase(exec, '/wt', 'main')

    expect(calls).toContainEqual(['git', 'rev-parse', '--verify', '--quiet', 'origin/main'])
    expect(calls).toContainEqual(['git', 'diff', '--numstat', 'origin/main...HEAD'])
    expect(changes).toEqual([
      { path: 'hello.txt', additions: 1, deletions: 0 },
      { path: 'image.png', additions: Number.NaN, deletions: Number.NaN },
    ])
  })

  test('falls back to the local base ref when origin is absent', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
      if (c.includes('--numstat')) return ok('2\t1\tsrc/app.ts\n')
      return undefined
    })
    const changes = await changesSinceBase(exec, '/wt', 'main')

    expect(calls).toContainEqual(['git', 'diff', '--numstat', 'main...HEAD'])
    expect(changes).toEqual([{ path: 'src/app.ts', additions: 2, deletions: 1 }])
  })
})

describe('backtickCodeRefs', () => {
  test('wraps file paths and file names in backticks', () => {
    expect(backtickCodeRefs('Write hello.txt, edit src/app.ts and packages/core/pr-body.ts')).toBe(
      'Write `hello.txt`, edit `src/app.ts` and `packages/core/pr-body.ts`',
    )
  })

  test('wraps identifiers in backticks', () => {
    expect(
      backtickCodeRefs('set in_progress via Runner.drive, call formatPrBody and close am-9h4'),
    ).toBe('set `in_progress` via `Runner.drive`, call `formatPrBody` and close `am-9h4`')
  })

  test('wraps commands, flags and issue references in backticks', () => {
    expect(backtickCodeRefs('Run with --dry-run, see PR #30\n$ bun test')).toBe(
      'Run with `--dry-run`, see PR `#30`\n$ `bun test`',
    )
  })

  test('leaves existing backticks and fenced blocks untouched', () => {
    const text = 'Run `bun run dev`\n```\ngit status\n```\nthen in_progress'
    expect(backtickCodeRefs(text)).toBe(
      'Run `bun run dev`\n```\ngit status\n```\nthen `in_progress`',
    )
  })

  test('leaves plain English prose alone', () => {
    expect(backtickCodeRefs('The summary section is now readable and consistent.')).toBe(
      'The summary section is now readable and consistent.',
    )
  })
})

describe('formatPrBody', () => {
  test('renders the title, task, description and changes in markdown with emojis', () => {
    const body = formatPrBody(TASK, [
      { path: 'hello.txt', additions: 1, deletions: 0 },
      { path: 'image.png', additions: Number.NaN, deletions: Number.NaN },
    ])

    expect(body).toContain('## ✨ Add a greeting file')
    expect(body).toContain('**Task:** `am-1`')
    expect(body).toContain('### 📝 Summary')
    expect(body).toContain('Write `hello.txt`')
    expect(body).toContain('### 🛠️ What changed')
    expect(body).toContain('- `hello.txt` +1 -0')
    expect(body).toContain('- `image.png` binary')
  })

  test('omits the changes section when nothing changed', () => {
    const body = formatPrBody(TASK, [])
    expect(body).toContain('## ✨ Add a greeting file')
    expect(body).not.toContain('What changed')
  })

  test('renders the how-to-use part of the description as its own section', () => {
    const body = formatPrBody(
      { ...TASK, description: 'Write hello.txt\n\n### How to use\n\nRun `hello` to greet' },
      [],
    )

    expect(body).toContain('### 📝 Summary')
    expect(body).toContain('Write `hello.txt`')
    expect(body).toContain('### 🚀 How to use')
    expect(body).toContain('Run `hello` to greet')
  })

  test('treats a description without a how-to-use heading as a plain summary', () => {
    const body = formatPrBody({ ...TASK, description: 'Write hello.txt' }, [])
    expect(body).toContain('### 📝 Summary')
    expect(body).toContain('Write `hello.txt`')
    expect(body).not.toContain('How to use')
  })
})
