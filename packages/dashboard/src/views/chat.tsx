import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { SquarePen } from 'lucide-react'
import { apiBase } from '../api.ts'
import logoGlyph from '../assets/logo-glyph.png'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '../components/ui/sidebar.tsx'
import { Markdown } from '../markdown.tsx'
import { useDashboard } from '../store.tsx'
import { Icon } from '../ui.tsx'

type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string }
type ChatThread = {
  id: string
  title: string
  updatedAt: number
  harness: string
  model: string
  customModel?: boolean
  effort: string
  messages: ChatMessage[]
}
type ChatOptions = {
  harnesses: { kind: string; model?: string; effort?: string }[]
  models: Record<string, string[]>
  efforts: Record<string, string[]>
  defaultHarness: { kind: string; model?: string; effort?: string }
}

function storageKey(repo: string): string {
  return `amagi:chat:${repo}`
}

function readThreads(repo: string): ChatThread[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(repo)) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(
      (thread): thread is ChatThread =>
        typeof thread === 'object' &&
        thread !== null &&
        'id' in thread &&
        typeof thread.id === 'string' &&
        'messages' in thread &&
        Array.isArray(thread.messages),
    )
  } catch {
    return []
  }
}

function chatTitle(message: string): string {
  const title = message.replace(/\s+/g, ' ').trim()
  return title.length > 48 ? `${title.slice(0, 48)}…` : title || 'New chat'
}

function harnessLabel(kind: string): string {
  if (kind === 'claude') return 'Claude'
  if (kind === 'codex') return 'Codex'
  if (kind === 'opencode') return 'OpenCode'
  return kind
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null
}

const DAY_MS = 86_400_000

function groupLabel(updatedAt: number): string {
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (updatedAt >= startOfToday) return 'Today'
  if (updatedAt >= startOfToday - DAY_MS) return 'Yesterday'
  if (updatedAt >= startOfToday - 7 * DAY_MS) return 'Previous 7 days'
  return 'Older'
}

function newThread(options: ChatOptions): ChatThread | null {
  const harness =
    options.harnesses.find((item) => item.kind === options.defaultHarness.kind) ??
    options.harnesses[0]
  if (harness === undefined) return null
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    updatedAt: Date.now(),
    harness: harness.kind,
    model: harness.model ?? '',
    customModel: false,
    effort: harness.effort ?? '',
    messages: [],
  }
}

const pickerItemClass =
  'flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-fg hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-ink'

function ChatOptionsBar({
  thread,
  options,
  disabled,
  onChange,
}: {
  thread: ChatThread
  options: ChatOptions
  disabled: boolean
  onChange: (patch: Partial<ChatThread>) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [harnessOpen, setHarnessOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const customModelInputRef = useRef<HTMLInputElement>(null)
  const harnessPickerRef = useRef<HTMLDivElement>(null)
  const harnessButtonRef = useRef<HTMLButtonElement>(null)
  const harness = options.harnesses.find((item) => item.kind === thread.harness)
  const models = [...new Set([...(options.models[thread.harness] ?? []), harness?.model])].filter(
    (model): model is string => model !== undefined,
  )
  const customModel = thread.customModel ?? (thread.model !== '' && !models.includes(thread.model))
  useLayoutEffect(() => {
    if (open && customModel) customModelInputRef.current?.focus()
  }, [open, customModel])
  const modelLabel = customModel
    ? thread.model || 'Custom model'
    : thread.model || harness?.model || 'Default model'
  const efforts = [
    ...new Set([...(options.efforts[thread.harness] ?? []), harness?.effort, thread.effort]),
  ].filter((effort): effort is string => effort !== undefined && effort !== '')
  const effortLabel = thread.effort || 'Default effort'

  useEffect(() => {
    if (!open && !harnessOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node) {
        if (!pickerRef.current?.contains(event.target)) {
          setOpen(false)
          setEffortOpen(false)
        }
        if (!harnessPickerRef.current?.contains(event.target)) setHarnessOpen(false)
      }
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (harnessOpen) harnessButtonRef.current?.focus()
        else modelButtonRef.current?.focus()
        setOpen(false)
        setEffortOpen(false)
        setHarnessOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, harnessOpen])

  useEffect(() => {
    if (disabled) {
      setOpen(false)
      setEffortOpen(false)
      setHarnessOpen(false)
    }
  }, [disabled])

  const selectHarness = (kind: string) => {
    const next = options.harnesses.find((item) => item.kind === kind)
    onChange({
      harness: kind,
      model: next?.model ?? '',
      customModel: false,
      effort: next?.effort ?? '',
    })
    setHarnessOpen(false)
    harnessButtonRef.current?.focus()
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5">
      <div ref={harnessPickerRef} className="relative">
        <button
          type="button"
          ref={harnessButtonRef}
          aria-label="Harness"
          aria-expanded={harnessOpen}
          aria-controls={`${id}-harnesses`}
          title="Harness"
          disabled={disabled}
          onClick={() => {
            setOpen(false)
            setEffortOpen(false)
            setHarnessOpen(!harnessOpen)
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs font-medium text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-ink disabled:opacity-50"
        >
          {harnessLabel(thread.harness)}
          <span aria-hidden="true" className="text-fg-faint">
            ⌄
          </span>
        </button>
        {harnessOpen && (
          <div
            id={`${id}-harnesses`}
            className="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-xl border border-line bg-surface p-2 shadow-xl"
          >
            {options.harnesses.map((item) => (
              <button
                key={item.kind}
                type="button"
                aria-pressed={thread.harness === item.kind}
                onClick={() => selectHarness(item.kind)}
                className={pickerItemClass}
              >
                <span>{harnessLabel(item.kind)}</span>
                {thread.harness === item.kind && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div ref={pickerRef} className="relative">
        <button
          type="button"
          ref={modelButtonRef}
          aria-label={`Model ${modelLabel}, effort ${effortLabel}`}
          aria-expanded={open}
          aria-controls={`${id}-picker`}
          disabled={disabled}
          onClick={() => {
            setOpen(!open)
            setEffortOpen(false)
          }}
          className="flex h-8 min-w-0 max-w-64 items-center gap-2 rounded-lg px-2 text-xs text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-ink disabled:opacity-50"
        >
          <span className="max-w-40 truncate font-medium text-fg">{modelLabel}</span>
          <span className="shrink-0 text-fg-faint">{effortLabel}</span>
          <span aria-hidden="true" className="text-fg-faint">
            ⌄
          </span>
        </button>
        {open && (
          <div
            id={`${id}-picker`}
            className="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-2 shadow-xl"
          >
            <div className="max-h-56 overflow-y-auto">
              <button
                type="button"
                aria-pressed={!customModel && thread.model === ''}
                onClick={() => {
                  onChange({ model: '', customModel: false })
                  setOpen(false)
                }}
                className={pickerItemClass}
              >
                <span>Default model</span>
                {!customModel && thread.model === '' && <span aria-hidden="true">✓</span>}
              </button>
              {models.map((model) => (
                <button
                  key={model}
                  type="button"
                  aria-pressed={!customModel && thread.model === model}
                  onClick={() => {
                    onChange({ model, customModel: false })
                    setOpen(false)
                  }}
                  className={pickerItemClass}
                >
                  <span className="truncate">{model}</span>
                  {!customModel && thread.model === model && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            <div className="my-1.5 border-t border-line" />
            <button
              type="button"
              aria-pressed={customModel}
              onClick={() => {
                setEffortOpen(false)
                onChange({ model: customModel ? thread.model : '', customModel: true })
              }}
              className={pickerItemClass}
            >
              <span>{customModel ? 'Custom model' : 'Custom model…'}</span>
              {customModel && <span aria-hidden="true">✓</span>}
            </button>
            {customModel && (
              <input
                ref={customModelInputRef}
                aria-label="Custom model"
                title="Custom model"
                value={thread.model}
                disabled={disabled}
                placeholder="Enter model ID"
                onChange={(event) => onChange({ model: event.target.value, customModel: true })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  setEffortOpen(false)
                  setOpen(false)
                  modelButtonRef.current?.focus()
                }}
                className="mt-1 h-9 w-full rounded-lg border border-line-strong bg-sunken px-2.5 text-sm font-mono text-fg outline-none placeholder:text-fg-faint focus-visible:border-fg-dim focus-visible:outline-none!"
              />
            )}
            <div className="my-1.5 border-t border-line" />
            <div className="relative">
              <button
                type="button"
                aria-expanded={effortOpen}
                aria-controls={`${id}-efforts`}
                onClick={() => setEffortOpen(!effortOpen)}
                className={`${pickerItemClass} ${effortOpen ? 'bg-surface-muted' : ''}`}
              >
                <span>Effort</span>
                <span className="flex items-center gap-2 text-fg-muted">
                  {effortLabel}
                  <span aria-hidden="true">›</span>
                </span>
              </button>
              {effortOpen && (
                <div
                  id={`${id}-efforts`}
                  className="absolute right-0 bottom-full z-[60] mb-1 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-2 shadow-xl sm:bottom-0 sm:left-full sm:right-auto sm:mb-0 sm:ml-1"
                >
                  <button
                    type="button"
                    aria-pressed={thread.effort === ''}
                    onClick={() => {
                      onChange({ effort: '' })
                      setEffortOpen(false)
                      setOpen(false)
                    }}
                    className={pickerItemClass}
                  >
                    <span>Default effort</span>
                    {thread.effort === '' && <span aria-hidden="true">✓</span>}
                  </button>
                  {efforts.map((effort) => (
                    <button
                      key={effort}
                      type="button"
                      aria-pressed={thread.effort === effort}
                      onClick={() => {
                        onChange({ effort })
                        setEffortOpen(false)
                        setOpen(false)
                      }}
                      className={pickerItemClass}
                    >
                      <span className="capitalize">{effort}</span>
                      {thread.effort === effort && <span aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2.5 text-sm text-fg-faint">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-faint"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      {label}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (non-secure context); leave the button quiet
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copy reply"
      title="Copy"
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-faint hover:bg-raised hover:text-fg"
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied && 'Copied'}
    </button>
  )
}

const SUGGESTIONS = ['Summarize this repository', 'Explain a file', 'Help me debug an issue']

export function ChatView() {
  const { selected: repo } = useDashboard()
  return <ChatWorkspace key={repo ?? ''} repo={repo} />
}

// Keyed by repo: threads load from that repo's storage on mount, so a stale write can't cross repos.
function ChatWorkspace({ repo }: { repo: string | null }) {
  const [threads, setThreads] = useState<ChatThread[]>(() =>
    repo === null ? [] : readThreads(repo),
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [options, setOptions] = useState<ChatOptions | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Follow the stream only while the reader is at the bottom; scrolling up pins the view.
  const stickToBottom = useRef(true)
  const activeThread = threads.find((thread) => thread.id === activeId)
  const activeMessages = activeThread?.messages ?? []
  const lastMessage = activeMessages.at(-1)
  const isEmpty = activeMessages.length === 0
  const needsThread = options !== null && activeThread === undefined
  const history = threads
    .filter((thread) => thread.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const groups: { label: string; threads: ChatThread[] }[] = []
  for (const thread of history) {
    const label = groupLabel(thread.updatedAt)
    const group = groups.at(-1)
    if (group?.label === label) group.threads.push(thread)
    else groups.push({ label, threads: [thread] })
  }

  useEffect(() => {
    if (repo === null) return
    let active = true
    fetch(`${apiBase}/api/repos/${encodeURIComponent(repo)}/chat/options`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as ChatOptions
      })
      .then((value) => {
        if (active) setOptions(value)
      })
      .catch(() => {
        if (active) setError('could not load chat harness options')
      })
    return () => {
      active = false
    }
  }, [repo])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (repo === null) return
    try {
      localStorage.setItem(
        storageKey(repo),
        JSON.stringify(threads.filter((thread) => thread.messages.length > 0)),
      )
    } catch {
      // The conversation remains available for this page visit if storage is full.
    }
  }, [repo, threads])

  // Like claude.ai, the page opens on a fresh draft; it only enters history once sent.
  useEffect(() => {
    if (!needsThread || options === null) return
    const thread = newThread(options)
    if (thread === null) return
    setThreads((current) => [thread, ...current])
    setActiveId(thread.id)
  }, [needsThread, options])

  useEffect(() => {
    if (activeId !== null) textareaRef.current?.focus()
  }, [activeId])

  useEffect(() => {
    const el = scrollRef.current
    if (lastMessage !== undefined && el !== null && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [lastMessage])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change, including the reset after send.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const onScroll = () => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickToBottom.current = atBottom
    setShowJump(!atBottom)
  }

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (el === null) return
    stickToBottom.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const selectThread = (id: string) => {
    stickToBottom.current = true
    setShowJump(false)
    setActiveId(id)
    setError(null)
  }

  const updateActive = (patch: Partial<ChatThread>) => {
    if (activeId === null) return
    setThreads((current) =>
      current.map((thread) =>
        thread.id === activeId ? { ...thread, ...patch, updatedAt: Date.now() } : thread,
      ),
    )
  }

  const createThread = () => {
    if (activeThread !== undefined && activeThread.messages.length === 0) {
      textareaRef.current?.focus()
      return
    }
    if (options === null) return
    const thread = newThread(options)
    if (thread === null) return
    setThreads((current) => [thread, ...current])
    selectThread(thread.id)
  }

  const deleteThread = (id: string) => {
    setThreads((current) => current.filter((thread) => thread.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const appendAssistantText = (threadId: string, messageId: string, chunk: string) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id !== threadId
          ? thread
          : {
              ...thread,
              updatedAt: Date.now(),
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? { ...message, content: message.content + chunk }
                  : message,
              ),
            },
      ),
    )
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (
      message === '' ||
      sending ||
      repo === null ||
      activeThread === undefined ||
      options === null
    )
      return
    setText('')
    setError(null)
    setActivity('Thinking…')
    setSending(true)
    stickToBottom.current = true
    setShowJump(false)
    const thread = activeThread
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: message }
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
    }
    const history = thread.messages
      .filter((item) => item.content.trim() !== '')
      .slice(-50)
      .map(({ role, content }) => ({ role, content }))
    setThreads((current) =>
      current.map((item) =>
        item.id === thread.id
          ? {
              ...item,
              title: item.messages.length === 0 ? chatTitle(message) : item.title,
              updatedAt: Date.now(),
              messages: [...item.messages, userMessage, assistantMessage],
            }
          : item,
      ),
    )

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const response = await fetch(`${apiBase}/api/repos/${encodeURIComponent(repo)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversationId: thread.id,
          harness: thread.harness,
          ...(thread.model.trim() === '' ? {} : { model: thread.model.trim() }),
          ...(thread.effort.trim() === '' ? {} : { effort: thread.effort.trim() }),
          message,
          history,
        }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      if (response.body === null) throw new Error('chat response has no stream')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const handle = (block: string) => {
        const packet = parseSseBlock(block)
        if (packet === null) return
        if (packet.event === 'agent') {
          const agentEvent = JSON.parse(packet.data) as {
            kind?: string
            text?: string
            message?: string
          }
          if (agentEvent.kind === 'text' && typeof agentEvent.text === 'string') {
            setActivity(null)
            appendAssistantText(thread.id, assistantMessage.id, agentEvent.text)
          } else if (agentEvent.kind === 'status' && typeof agentEvent.message === 'string') {
            setActivity(agentEvent.message)
          }
        } else if (packet.event === 'error') {
          const detail = JSON.parse(packet.data) as { error?: string }
          setError(detail.error ?? 'chat run failed')
        } else if (packet.event === 'done') {
          const result = JSON.parse(packet.data) as { ok?: boolean; error?: string }
          if (result.ok === false) setError(result.error ?? 'chat run failed')
        }
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          handle(buffer.slice(0, boundary).replace(/\r/g, ''))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') handle(buffer.replace(/\r/g, ''))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setThreads((current) =>
          current.map((item) =>
            item.id !== thread.id
              ? item
              : {
                  ...item,
                  messages: item.messages.map((reply) =>
                    reply.id === assistantMessage.id && reply.content === ''
                      ? { ...reply, content: 'Stopped.' }
                      : reply,
                  ),
                },
          ),
        )
      } else {
        setError(err instanceof Error ? err.message : 'could not reach the amagi server')
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setSending(false)
        setActivity(null)
      }
    }
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <SidebarProvider className="-mx-4 -my-6 h-[calc(100dvh-var(--app-header-height))] min-h-0 overflow-hidden bg-app sm:-mx-6">
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={createThread}
                disabled={options === null || options.harnesses.length === 0}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="group-data-[collapsible=icon]:hidden">New chat</span>
                  <SquarePen aria-hidden="true" className="size-4 shrink-0" />
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.length === 0 && (
            <p className="px-3 text-xs leading-5 text-fg-faint">
              Your conversations will appear here.
            </p>
          )}
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu>
                {group.threads.map((thread) => (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton
                      isActive={thread.id === activeId}
                      onClick={() => selectThread(thread.id)}
                      title={thread.title}
                    >
                      <span>{thread.title}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      aria-label={`Delete ${thread.title}`}
                      title="Delete"
                      onClick={() => deleteThread(thread.id)}
                    >
                      <Icon name="close" size={13} />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <p className="truncate px-2 text-[11px] text-fg-faint">
            {repo ?? 'No repository selected'}
          </p>
        </SidebarFooter>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 px-4 sm:px-6">
          <SidebarTrigger />
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {isEmpty ? '' : activeThread?.title}
          </h1>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-end px-4 pb-8 text-center">
              <img src={logoGlyph} alt="Amagi" className="mb-5 h-12 w-auto" />
              <h2 className="text-3xl font-normal tracking-tight text-fg-strong">
                What can I help with?
              </h2>
              <p className="mt-2 max-w-md text-sm text-fg-faint">
                Ask anything about {repo ?? 'this repository'}. The assistant can read it but not
                change it.
              </p>
            </div>
          ) : (
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-6 px-4 pt-4 pb-10 sm:px-6">
                {activeMessages.map((message) => {
                  const streaming = sending && message.id === lastMessage?.id
                  if (message.role === 'user') {
                    return (
                      <div key={message.id} className="flex justify-end">
                        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px] leading-6 text-fg-strong">
                          {message.content}
                        </p>
                      </div>
                    )
                  }
                  return (
                    <article key={message.id} className="group">
                      {message.content !== '' && (
                        <div className="chat-reply">
                          <Markdown text={message.content} />
                        </div>
                      )}
                      {streaming && (message.content === '' || activity !== null) && (
                        <div className={message.content === '' ? '' : 'mt-3'}>
                          <ThinkingIndicator label={activity ?? 'Thinking…'} />
                        </div>
                      )}
                      {!streaming && message.content === '' && (
                        <p className="text-sm italic text-fg-faint">No response.</p>
                      )}
                      {!streaming && message.content !== '' && (
                        <div
                          className={`-ml-2 mt-2 flex ${message.id === lastMessage?.id ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'}`}
                        >
                          <CopyButton text={message.content} />
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </div>
          )}
          {showJump && !isEmpty && (
            <button
              type="button"
              onClick={jumpToBottom}
              aria-label="Scroll to bottom"
              className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-line-strong bg-surface text-fg-muted shadow-lg hover:text-fg"
            >
              <Icon name="arrowDown" size={16} />
            </button>
          )}
        </div>

        <div className="shrink-0 px-4 pb-3 sm:px-6">
          <div className="mx-auto max-w-3xl">
            {error !== null && (
              <p
                role="alert"
                className="mb-2 rounded-xl border border-red-edge bg-red-soft px-3 py-2 text-xs text-red-ink"
              >
                {error}
              </p>
            )}
            <form
              onSubmit={send}
              className="rounded-3xl border border-line-strong bg-surface shadow-[0_6px_24px_-12px_var(--shadow-color)] transition-colors focus-within:border-fg-dim"
            >
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onComposerKeyDown}
                disabled={activeThread === undefined || options === null}
                rows={1}
                maxLength={4000}
                aria-label="Message"
                placeholder={isEmpty ? 'How can I help you today?' : 'Reply…'}
                className="block max-h-60 w-full resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 text-fg-strong outline-none placeholder:text-fg-faint focus-visible:outline-none!"
              />
              <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
                {activeThread !== undefined && options !== null && (
                  <ChatOptionsBar
                    thread={activeThread}
                    options={options}
                    disabled={sending}
                    onChange={updateActive}
                  />
                )}
                {sending ? (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    aria-label="Stop"
                    title="Stop"
                    className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg-strong text-app hover:opacity-85"
                  >
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    aria-label="Send"
                    title="Send"
                    disabled={text.trim() === '' || activeThread === undefined || options === null}
                    className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-solid hover:opacity-90 disabled:bg-raised disabled:text-fg-faint"
                  >
                    <Icon name="arrowUp" size={16} />
                  </button>
                )}
              </div>
            </form>
            <p className="mt-2 text-center text-[11px] text-fg-faint">
              Enter to send, Shift+Enter for a new line. Chats are kept in this browser.
            </p>
          </div>
        </div>

        {isEmpty && (
          <div className="flex flex-1 flex-wrap content-start justify-center gap-2 px-4 pt-3">
            {SUGGESTIONS.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                onClick={() => {
                  setText(suggestion)
                  textareaRef.current?.focus()
                }}
                disabled={activeThread === undefined}
                className="h-fit rounded-full border border-line-strong px-3.5 py-1.5 text-xs text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </SidebarProvider>
  )
}
