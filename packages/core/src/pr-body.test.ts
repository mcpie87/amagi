import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import {
  backtickFileRefs,
  changesSinceBase,
  formatPrBody,
  taskIdFromPrBody,
  withAgentSections,
} from './pr-body.ts'

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

describe('backtickFileRefs', () => {
  test('wraps file paths and file names in backticks', () => {
    expect(backtickFileRefs('Write hello.txt, edit src/app.ts and packages/core/pr-body.ts')).toBe(
      'Write `hello.txt`, edit `src/app.ts` and `packages/core/pr-body.ts`',
    )
  })

  test('leaves existing backticks and fenced blocks untouched', () => {
    const text = 'Run `bun run dev`\n```\ngit status\n```\nthen edit src/app.ts'
    expect(backtickFileRefs(text)).toBe(
      'Run `bun run dev`\n```\ngit status\n```\nthen edit `src/app.ts`',
    )
  })

  test('leaves plain English prose alone', () => {
    expect(backtickFileRefs('The summary section is now readable and consistent.')).toBe(
      'The summary section is now readable and consistent.',
    )
  })

  test('does not wrap a prefix of a longer dotted token', () => {
    const text = 'text is date.toLocaleString(...)'
    expect(backtickFileRefs(text)).toBe(text)
  })

  test('does not rewrite markdown link destinations', () => {
    const text = '[x](/a/b/C.tsx)'
    expect(backtickFileRefs(text)).toBe(text)
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

  test('omits the Pre-flight section while keeping the surrounding description', () => {
    const body = formatPrBody(
      {
        ...TASK,
        description:
          '## Goal\n\nKeep the task summary.\n\n## Pre-flight (runner: do this before writing code)\n\n- Check bd show\n- Search for the goal\n\n## Acceptance\n\nKeep this criterion.',
      },
      [],
    )

    expect(body).toContain('## Goal\n\nKeep the task summary.')
    expect(body).toContain('## Acceptance\n\nKeep this criterion.')
    expect(body).not.toContain('Pre-flight')
    expect(body).not.toContain('Check bd show')
    expect(body).not.toContain('Search for the goal')
  })

  test('renders the task creation date as a relative-time stamp when known', () => {
    const body = formatPrBody({ ...TASK, createdAt: Date.parse('2026-09-20T14:02:53Z') }, [])

    expect(body).toContain(
      '**Task:** `am-1` · created <relative-time datetime="2026-09-20T14:02:53.000Z">2026-09-20</relative-time>',
    )
  })

  test('omits the creation date when the tracker did not report one', () => {
    expect(formatPrBody(TASK, [])).toContain('**Task:** `am-1`')
    expect(formatPrBody({ ...TASK, createdAt: null }, [])).not.toContain('relative-time')
  })

  test('omits the changes section when nothing changed', () => {
    const body = formatPrBody(TASK, [])
    expect(body).toContain('## ✨ Add a greeting file')
    expect(body).not.toContain('What changed')
  })

  test('escapes HTML-like input and demotes internal headings below the summary heading', () => {
    const body = formatPrBody(
      {
        ...TASK,
        description:
          '## Goal\n\nText with <li> and <Time ts={s.startedAt}/> and <time dateTime="now">value</time>.\n\n## Context\n\nMore text.\n\n### Conclusion\n\nRendered <li> as text.',
      },
      [],
    )

    expect(body).toContain('#### Goal')
    expect(body).toContain('#### Context')
    expect(body).toContain('&lt;li&gt;')
    expect(body).toContain('&lt;Time ts={s.startedAt}/&gt;')
    expect(body).toContain('&lt;time dateTime="now"&gt;value&lt;/time&gt;')
    expect(body).toContain('Rendered &lt;li&gt; as text.')
    expect(body).not.toContain('<li>')
    expect(body).not.toContain('<Time')
    expect(body).not.toContain('<time')
  })

  test('keeps absolute worktree paths out of GitHub link destinations', () => {
    const body = formatPrBody(
      {
        ...TASK,
        description:
          'Summary\n\n### Conclusion\n\nSee [SessionsView.tsx](/home/user/.cache/amagi/worktrees/branch-name/packages/dashboard/src/SessionsView.tsx).',
      },
      [],
    )

    expect(body).toContain('[`SessionsView.tsx`](packages/dashboard/src/SessionsView.tsx)')
    expect(body).not.toContain('/home/user/.cache/amagi/worktrees')
  })

  test('cleans injected backticks when repairing an existing worktree link', () => {
    const body = formatPrBody(
      {
        ...TASK,
        description:
          'Summary\n\n### Conclusion\n\nSee [`SessionsView.tsx`](/`home/user/.cache/amagi/worktrees/branch-name/packages/dashboard/src/SessionsView.tsx`).',
      },
      [],
    )

    expect(body).toContain('[`SessionsView.tsx`](packages/dashboard/src/SessionsView.tsx)')
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

  test('renders the conclusion after the what-changed list, with the file names ticked', () => {
    const body = formatPrBody(
      {
        ...TASK,
        description:
          'Write hello.txt\n\n### Conclusion\n\nAdded hello.txt with a greeting; nothing else touched.',
      },
      [{ path: 'hello.txt', additions: 1, deletions: 0 }],
    )

    expect(body.indexOf('### 🛠️ What changed')).toBeLessThan(body.indexOf('### 🧠 Conclusion'))
    expect(body).toContain('### 🧠 Conclusion')
    expect(body).toContain('Added `hello.txt` with a greeting; nothing else touched.')
  })

  test('keeps both agent-authored sections and renders conclusion last', () => {
    const body = formatPrBody(
      {
        ...TASK,
        description:
          'Write hello.txt\n\n### Conclusion\n\nChanged hello.txt only.\n\n### How to use\n\nRun `hello`',
      },
      [],
    )

    expect(body.indexOf('### 🚀 How to use')).toBeLessThan(body.indexOf('### 🧠 Conclusion'))
    expect(body).toContain('Changed `hello.txt` only.')
    expect(body).toContain('Run `hello`')
  })

  test('uses the run summary as the conclusion when the agent wrote none', () => {
    const body = formatPrBody(TASK, [], undefined, 'Wrote hello.txt and removed stale config')

    expect(body).toContain('### 🧠 Conclusion')
    expect(body).toContain('Wrote `hello.txt` and removed stale config')
  })

  test('omits the conclusion when neither the description nor the summary has one', () => {
    const body = formatPrBody(TASK, [], undefined, '  ')
    expect(body).not.toContain('Conclusion')
  })

  test('the description conclusion wins over the run summary', () => {
    const body = formatPrBody(
      { ...TASK, description: 'Write hello.txt\n\n### Conclusion\n\nFrom the description' },
      [],
      undefined,
      'From the summary',
    )

    expect(body).toContain('From the description')
    expect(body).not.toContain('From the summary')
  })

  test('always renders a summary section, using the agent summary when the description is empty', () => {
    const body = formatPrBody(
      { ...TASK, description: '' },
      [],
      undefined,
      'Dedup by exact comment id, not by a numeric watermark.',
    )

    expect(body).toContain('### 📝 Summary')
    expect(body).toContain('Dedup by exact comment id, not by a numeric watermark.')
  })

  test('renders the summary heading even with no description and no agent summary', () => {
    const body = formatPrBody({ ...TASK, description: '' }, [])
    expect(body).toContain('### 📝 Summary')
  })

  test('appends a model/effort footer when metadata is supplied', () => {
    const body = formatPrBody(TASK, [], {
      harness: 'opencode',
      model: 'gemini-2.5-pro',
      effort: 'high',
    })

    expect(body).toContain(
      '<sub>Generated by amagi · opencode · gemini-2.5-pro · effort high</sub>',
    )
  })

  test('omits the footer when only the harness is known', () => {
    const body = formatPrBody(TASK, [], { harness: 'opencode', model: null, effort: null })
    expect(body).not.toContain('Generated by amagi')
  })

  test('ends with the footer, naming the task only at the top', () => {
    const body = formatPrBody(TASK, [], {
      harness: 'opencode',
      model: 'gemini-2.5-pro',
      effort: 'high',
    })
    expect(body.endsWith('</sub>')).toBe(true)
    expect(body.split('am-1')).toHaveLength(2)
  })
})

describe('withAgentSections', () => {
  test('is null when the final message has no sections', () => {
    expect(withAgentSections('Write hello.txt', 'Did it.')).toBeNull()
    expect(withAgentSections('Write hello.txt', null)).toBeNull()
  })

  test('appends the sections to the description and cuts them off the summary', () => {
    const merged = withAgentSections(
      'Write hello.txt',
      'Added the file.\n\n### How to use\n\nRun `hello`\n\n### Conclusion\n\nOnly hello.txt changed.',
    )
    expect(merged).toEqual({
      description:
        'Write hello.txt\n\n### How to use\n\nRun `hello`\n\n### Conclusion\n\nOnly hello.txt changed.',
      summary: 'Added the file.',
    })
  })

  test('replaces sections an earlier attempt left in the description', () => {
    const merged = withAgentSections(
      'Write hello.txt\n\n### Conclusion\n\nstale',
      'Done.\n\n### Conclusion\n\nfresh',
    )
    expect(merged?.description).toBe('Write hello.txt\n\n### Conclusion\n\nfresh')
  })
})

describe('taskIdFromPrBody', () => {
  test('reads the Task line back off a PR body', () => {
    const body = formatPrBody(TASK, [])
    expect(taskIdFromPrBody(body)).toBe('am-1')
  })

  test('finds a legacy trailer among other body text', () => {
    expect(taskIdFromPrBody('## Some PR\n\nDetails here.\n\namagi-task: am-3b8.2\n')).toBe(
      'am-3b8.2',
    )
  })

  test('is null for a body that names no task', () => {
    expect(taskIdFromPrBody('## Some PR\n\nMentions am-1 in passing.\n')).toBeNull()
  })
})
