import {
  HARDCODED_EFFORTS,
  HARDCODED_MODELS,
  type Harness,
  makeHarness,
  resolveHarnessKind,
  type Workspace,
  type Workspaces,
} from '@amagi/core'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { resolveWorkspace, valid } from './route-utils.ts'
import { ChatPageBody, RepoParam } from './schemas.ts'

const SYSTEM_PROMPT =
  'You are a helpful assistant chatting about the selected repository. You may inspect its files, but do not modify files or run commands that change repository state. Answer directly and use Markdown when it helps.'

type ChatHarnessConfig = Parameters<typeof makeHarness>[0]
const HARNESS_KINDS = ['claude', 'codex', 'opencode'] as const

export type ChatRouteDeps = {
  workspaces: Workspaces
  harnessFor?: (ws: Workspace, config: ChatHarnessConfig) => Harness
}

function transcript(history: { role: 'user' | 'assistant'; content: string }[], message: string) {
  if (history.length === 0) return message
  return `Conversation history as JSON data:\n${JSON.stringify(history)}\n\nCurrent user message:\n${message}`
}

export function createChatRoutes({ workspaces, harnessFor }: ChatRouteDeps) {
  const busy = new Set<string>()

  return new Hono()
    .get('/api/repos/:repo/chat/options', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const harnesses = HARNESS_KINDS.map((kind) => {
        const config = resolveHarnessKind(ws.config, kind)
        return {
          kind,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.effort === undefined ? {} : { effort: config.effort }),
        }
      })
      const defaultConfig = ws.config.harness.implement
      return c.json({
        harnesses,
        models: HARDCODED_MODELS,
        efforts: HARDCODED_EFFORTS,
        defaultHarness: {
          kind: defaultConfig.kind,
          ...(defaultConfig.model === undefined ? {} : { model: defaultConfig.model }),
          ...(defaultConfig.effort === undefined ? {} : { effort: defaultConfig.effort }),
        },
      })
    })
    .post('/api/repos/:repo/chat', valid('param', RepoParam), valid('json', ChatPageBody), (c) => {
      const { repo } = c.req.valid('param')
      const body = c.req.valid('json')
      const ws = resolveWorkspace(workspaces, repo)
      const key = `${repo}/${body.conversationId}`
      if (busy.has(key)) return c.json({ error: 'this conversation is already responding' }, 409)

      const config = {
        ...resolveHarnessKind(ws.config, body.harness),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.effort === undefined ? {} : { effort: body.effort }),
      }

      const harness = harnessFor?.(ws, config) ?? makeHarness(config)
      busy.add(key)
      return streamSSE(c, async (stream) => {
        let proc: ReturnType<Harness['start']> | undefined
        stream.onAbort(() => {
          if (proc !== undefined) void proc.kill()
        })
        try {
          proc = harness.start({
            cwd: ws.root,
            prompt: transcript(body.history, body.message),
            systemPrompt: SYSTEM_PROMPT,
            model: config.model,
            effort: config.effort,
            permissions: 'read-only',
            ...(config.seat === undefined ? {} : { seat: config.seat }),
            ...(config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools }),
            extraArgs: config.extraArgs,
          })
          for await (const event of proc.events()) {
            if (stream.aborted) break
            await stream.writeSSE({ event: 'agent', data: JSON.stringify(event) })
          }
          const outcome = await proc.done
          if (!stream.aborted) {
            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({
                ok: outcome.ok,
                error: outcome.ok ? undefined : (outcome.summary ?? outcome.stderr),
              }),
            })
          }
        } catch (err) {
          if (!stream.aborted) {
            const message = err instanceof Error ? err.message : String(err)
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: message }) })
          }
        } finally {
          busy.delete(key)
        }
      })
    })
}
