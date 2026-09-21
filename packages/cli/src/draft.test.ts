import { describe, expect, test } from 'bun:test'
import {
  type AgentEvent,
  type AgentOutcome,
  type AgentProcess,
  type AgentStartOptions,
  AsyncQueue,
  type Harness,
} from '@amagi/core'
import { answerPrompt, draftPrompt, draftTask, parseDraftOutput } from './draft.ts'

describe('parseDraftOutput', () => {
  test('parses the final task JSON, ignoring surrounding prose and fences', () => {
    const out = parseDraftOutput(
      '```json\n{"title": "Add a foo", "description": "Do the foo"}\n```',
    )
    expect(out).toEqual({ kind: 'task', title: 'Add a foo', description: 'Do the foo' })
  })

  test('parses clarifying questions', () => {
    const out = parseDraftOutput(
      'I need to know:\n{"questions": ["which registry?", "what target?"]}',
    )
    expect(out).toEqual({ kind: 'questions', questions: ['which registry?', 'what target?'] })
  })

  test('rejects empty or missing question lists', () => {
    expect(parseDraftOutput('{"questions": []}')).toBeNull()
    expect(parseDraftOutput('{"questions": ["  "]}')).toBeNull()
  })

  test('rejects non-JSON output', () => {
    expect(parseDraftOutput('sure, I will do it')).toBeNull()
  })
})

class FakeHarness implements Harness {
  readonly kind = 'fake'
  readonly calls: { resumeFrom: string | null; prompt: string }[] = []

  constructor(private readonly outputs: string[]) {}

  start(opts: AgentStartOptions): AgentProcess {
    return this.run(null, opts)
  }
  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.run(sessionId, opts)
  }
  async listModels(): Promise<string[]> {
    return []
  }

  private run(resumeFrom: string | null, opts: AgentStartOptions): AgentProcess {
    this.calls.push({ resumeFrom, prompt: opts.prompt })
    const text = this.outputs.shift() ?? '{}'

    const queue = new AsyncQueue<AgentEvent>()
    queue.push({ kind: 'text', text })
    queue.close()

    const outcome: AgentOutcome = {
      exitCode: 0,
      ok: true,
      sessionId: 'sess-1',
      summary: text,
      usage: null,
      stderr: '',
    }
    return {
      pid: -1,
      events: () => queue,
      done: Promise.resolve(outcome),
      kill: async () => {},
      model: null,
      effort: null,
    }
  }
}

const scriptedInput = (answers: (string | null)[]) => {
  let i = 0
  return { input: async () => answers[i++] ?? null }
}

describe('draftTask', () => {
  const implement = {
    kind: 'opencode' as const,
    permissions: 'workspace-write' as const,
    extraArgs: [] as string[],
  }

  test('asks clarifying questions and resumes the session with the answers', async () => {
    const harness = new FakeHarness([
      '{"questions": ["which registry?", "how many?"]}',
      '{"title": "Add a foo", "description": "Do the foo via the registry"}',
    ])
    const draft = await draftTask(
      harness,
      implement,
      'add a foo',
      scriptedInput(['npm', '2']),
      '/tmp',
    )

    expect(draft).toEqual({ title: 'Add a foo', description: 'Do the foo via the registry' })
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[0]?.prompt).toBe(draftPrompt('add a foo'))
    expect(harness.calls[1]?.resumeFrom).toBe('sess-1')
    expect(harness.calls[1]?.prompt).toBe(
      answerPrompt(['Q: which registry?\nA: npm', 'Q: how many?\nA: 2']),
    )
  })

  test('a cancelled answer aborts the draft', async () => {
    const harness = new FakeHarness(['{"questions": ["which registry?"]}'])
    await expect(
      draftTask(harness, implement, 'add a foo', scriptedInput([null]), '/tmp'),
    ).rejects.toThrow('draft cancelled')
  })
})
