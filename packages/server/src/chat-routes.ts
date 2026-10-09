import { mkdirSync } from 'node:fs'
import {
  type AgentStartOptions,
  type ChatConversation,
  errMsg,
  exec,
  HARDCODED_EFFORTS,
  HARDCODED_MODELS,
  type Harness,
  holdTaskForChat,
  makeHarness,
  resolveHarnessKind,
  runStateDir,
  taskChatSystemPrompt,
  type Workspace,
  type Workspaces,
} from '@amagi/core'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { resolveWorkspace, valid } from './route-utils.ts'
import { ChatConversationBody, ChatPageBody, RepoChatIdParam, RepoParam } from './schemas.ts'

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

function chatTitle(message: string): string {
  const title = message.replace(/\s+/g, ' ').trim()
  return title.length > 48 ? `${title.slice(0, 48)}…` : title || 'New chat'
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
    .get('/api/repos/:repo/chat/:id', valid('param', RepoChatIdParam), (c) => {
      const { repo, id } = c.req.valid('param')
      const conversation = resolveWorkspace(workspaces, repo).store.chatConversation(id)
      return conversation === null
        ? c.json({ error: 'chat session not found' }, 404)
        : c.json(conversation)
    })
    .put(
      '/api/repos/:repo/chat/:id',
      valid('param', RepoChatIdParam),
      valid('json', ChatConversationBody),
      (c) => {
        const { repo, id } = c.req.valid('param')
        const body = c.req.valid('json')
        const key = `${repo}/${id}`
        if (busy.has(key)) return c.json({ error: 'this conversation is already responding' }, 409)
        const conversation = resolveWorkspace(workspaces, repo).store.createChatConversation({
          id,
          title: body.title,
          harness: body.harness,
          model: body.model,
          effort: body.effort,
          messages: body.messages,
          ...(body.customModel === undefined ? {} : { customModel: body.customModel }),
          ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
          ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        })
        return c.json(conversation)
      },
    )
    .post('/api/repos/:repo/chat', valid('param', RepoParam), valid('json', ChatPageBody), (c) => {
      const { repo } = c.req.valid('param')
      const body = c.req.valid('json')
      const ws = resolveWorkspace(workspaces, repo)
      const key = `${repo}/${body.conversationId}`
      if (busy.has(key)) return c.json({ error: 'this conversation is already responding' }, 409)
      const previous = ws.store.chatConversation(body.conversationId)
      const taskId = body.taskId ?? previous?.taskId
      const sessionId = body.sessionId ?? previous?.sessionId
      const customModel = body.customModel ?? previous?.customModel
      // Two conversations on one task would share its worktree.
      const taskKey = taskId === undefined ? null : `${repo}/task/${taskId}`
      if (taskKey !== null && busy.has(taskKey)) {
        return c.json({ error: `an agent is already responding on ${taskId}` }, 409)
      }

      const config = {
        ...resolveHarnessKind(ws.config, body.harness),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.effort === undefined ? {} : { effort: body.effort }),
      }

      const harness = harnessFor?.(ws, config) ?? makeHarness(config)
      const priorMessages =
        previous?.messages ??
        body.history.map((message) => ({
          ...message,
          id: crypto.randomUUID(),
        }))
      const userMessage = { id: crypto.randomUUID(), role: 'user' as const, content: body.message }
      const assistantMessage = { id: crypto.randomUUID(), role: 'assistant' as const, content: '' }
      const priorUserMessage = priorMessages.find((message) => message.role === 'user')
      const conversation: ChatConversation = {
        id: body.conversationId,
        title: previous?.title ?? chatTitle(priorUserMessage?.content ?? body.message),
        harness: body.harness,
        model: body.model ?? '',
        effort: body.effort ?? '',
        ...(customModel === undefined ? {} : { customModel }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        messages: [...priorMessages, userMessage, assistantMessage],
        updatedAt: previous?.updatedAt ?? Date.now(),
      }
      ws.store.saveChatConversation(conversation)
      busy.add(key)
      if (taskKey !== null) busy.add(taskKey)
      return streamSSE(c, async (stream) => {
        let proc: ReturnType<Harness['start']> | undefined
        let reply = ''
        let finalSessionId = sessionId
        stream.onAbort(() => {
          if (proc !== undefined) void proc.kill()
        })
        try {
          const shared = {
            model: config.model,
            effort: config.effort,
            // Chats bypass seats; only the host-wide process cap can queue them.
            seat: null,
            ...(config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools }),
            extraArgs: config.extraArgs,
          }
          let opts: AgentStartOptions = {
            ...shared,
            cwd: ws.root,
            prompt: transcript(
              priorMessages.slice(-50).map(({ role, content }) => ({ role, content })),
              body.message,
            ),
            systemPrompt: SYSTEM_PROMPT,
            permissions: 'read-only',
          }
          if (taskId !== undefined) {
            await stream.writeSSE({
              event: 'agent',
              data: JSON.stringify({ kind: 'status', message: 'Preparing the task worktree…' }),
            })
            const hold = await holdTaskForChat(
              {
                store: ws.store,
                tracker: ws.tracker,
                config: ws.config,
                repoRoot: ws.root,
                repoName: ws.name,
                exec,
              },
              taskId,
            )
            if (!hold.ok) throw new Error(hold.error)
            const { format, lint, test, commands } = ws.config.checks
            const runState = runStateDir(taskId)
            mkdirSync(runState, { recursive: true })
            opts = {
              ...shared,
              cwd: hold.cwd,
              // A resumed session already holds the conversation.
              prompt:
                sessionId === undefined
                  ? transcript(
                      priorMessages.slice(-50).map(({ role, content }) => ({ role, content })),
                      body.message,
                    )
                  : body.message,
              systemPrompt: taskChatSystemPrompt({
                task: hold.task,
                worktree: hold.cwd,
                branch: hold.branch,
                baseBranch: ws.config.repo.baseBranch,
                checks: [format, lint, test, ...commands].filter(
                  (command): command is string => command !== null && command !== '',
                ),
                prUrl: hold.prUrl,
              }),
              permissions: config.permissions,
              env: {
                AMAGI_TASK_TOKEN: ws.store.token(taskId),
                AMAGI_WORKTREE: hold.cwd,
                AMAGI_REPO_ROOT: ws.root,
                AMAGI_RUN_STATE: runState,
              },
            }
          }
          proc =
            taskId !== undefined && sessionId !== undefined
              ? harness.resume(sessionId, opts)
              : harness.start(opts)
          for await (const event of proc.events()) {
            if (stream.aborted) break
            if (event.kind === 'text') reply += event.text
            await stream.writeSSE({ event: 'agent', data: JSON.stringify(event) })
          }
          const outcome = await proc.done
          finalSessionId = outcome.sessionId ?? finalSessionId
          if (!stream.aborted) {
            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({
                ok: outcome.ok,
                error: outcome.ok ? undefined : (outcome.summary ?? outcome.stderr),
                sessionId: outcome.sessionId,
              }),
            })
          }
        } catch (err) {
          if (!stream.aborted) {
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: errMsg(err) }) })
          }
        } finally {
          ws.store.saveChatConversation({
            ...conversation,
            ...(finalSessionId === undefined ? {} : { sessionId: finalSessionId }),
            messages: conversation.messages.map((message) =>
              message.id === assistantMessage.id ? { ...message, content: reply } : message,
            ),
          })
          busy.delete(key)
          if (taskKey !== null) busy.delete(taskKey)
        }
      })
    })
}
