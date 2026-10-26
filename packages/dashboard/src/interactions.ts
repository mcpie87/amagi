import type {
  InteractionKind,
  InteractionOutcome,
  InteractionRequest,
  InteractionSample,
} from '@amagi/core/interaction-timings'
import { apiBase } from './api.ts'

export type InteractionRecord = Omit<InteractionSample, 'id'>

type Target = Pick<InteractionSample, 'kind' | 'action' | 'context' | 'route' | 'path'>

/** A request started inside the event or a chained fetch landing within it still counts. */
const GRACE_MS = 100
const TIMEOUT_MS = 15_000
const FLUSH_MS = 5000
const FLUSH_BATCH = 50

type Timer = ReturnType<typeof setTimeout>

export type TrackerDeps = {
  now: () => number
  wallNow: () => number
  /** Runs `callback` once the next frame has been painted. */
  afterPaint: (callback: () => void) => void
  setTimeout: (callback: () => void, ms: number) => Timer
  clearTimeout: (timer: Timer) => void
  emit: (record: InteractionRecord) => void
}

type Pending = {
  target: Target
  start: number
  at: number
  paintMs: number | null
  inflight: number
  /** Bumped by every request start, so a settle check scheduled before it is stale. */
  generation: number
  requests: InteractionRequest[]
  grace: Timer | null
  timeout: Timer
}

/**
 * Times one interaction at a time: input to first paint, and input to
 * settled, meaning painted with every request it started finished and no new
 * one for GRACE_MS. A new interaction supersedes the open one.
 */
export class InteractionTracker {
  private current: Pending | null = null

  constructor(private readonly deps: TrackerDeps) {}

  /** `start` is the input's `event.timeStamp`, on the same clock as `deps.now`. */
  begin(target: Target, start: number): void {
    if (this.current !== null) this.finish(this.current, 'superseded', start)
    const { deps } = this
    const pending: Pending = {
      target,
      start,
      at: deps.wallNow() - (deps.now() - start),
      paintMs: null,
      inflight: 0,
      generation: 0,
      requests: [],
      grace: null,
      timeout: deps.setTimeout(() => this.finish(pending, 'timeout', deps.now()), TIMEOUT_MS),
    }
    this.current = pending
    deps.afterPaint(() => {
      if (this.current !== pending) return
      pending.paintMs = deps.now() - start
      this.settleSoon(pending, deps.now())
    })
  }

  /** Attributes a request to the open interaction; call the returned function when it ends. */
  request(method: string, path: string): ((status: number) => void) | null {
    const pending = this.current
    if (pending === null) return null
    const { deps } = this
    const startedAt = deps.now()
    const entry: InteractionRequest = {
      method,
      path,
      startMs: startedAt - pending.start,
      ms: null,
      status: null,
    }
    pending.requests.push(entry)
    pending.inflight++
    pending.generation++
    if (pending.grace !== null) deps.clearTimeout(pending.grace)
    pending.grace = null
    return (status) => {
      entry.ms = deps.now() - startedAt
      entry.status = status
      pending.inflight--
      if (this.current !== pending || pending.inflight > 0) return
      deps.afterPaint(() => this.settleSoon(pending, deps.now()))
    }
  }

  private settleSoon(pending: Pending, end: number): void {
    if (this.current !== pending || pending.inflight > 0 || pending.paintMs === null) return
    const { deps } = this
    if (pending.grace !== null) deps.clearTimeout(pending.grace)
    const generation = pending.generation
    pending.grace = deps.setTimeout(() => {
      if (pending.inflight === 0 && pending.generation === generation) {
        this.finish(pending, 'settled', end)
      }
    }, GRACE_MS)
  }

  private finish(pending: Pending, outcome: InteractionOutcome, end: number): void {
    if (this.current !== pending) return
    this.current = null
    const { deps } = this
    deps.clearTimeout(pending.timeout)
    if (pending.grace !== null) deps.clearTimeout(pending.grace)
    deps.emit({
      ...pending.target,
      at: pending.at,
      paintMs: pending.paintMs,
      ms: Math.max(0, end - pending.start),
      outcome,
      requests: pending.requests.map((r) => ({ ...r })),
    })
  }
}

const MAX_LABEL = 60

function clean(text: string | null | undefined): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL - 1)}…` : value
}

function firstText(element: Element): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = clean(node.textContent)
    if (text !== '') return text
  }
  return ''
}

function labelledBy(element: Element): string {
  const ids = element.getAttribute('aria-labelledby')
  if (ids === null) return ''
  return clean(
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  )
}

/** Short text reads as the name; long text (a card, a row) falls back to its first line. */
function elementName(element: Element): string {
  const aria = clean(element.getAttribute('aria-label')) || labelledBy(element)
  if (aria !== '') return aria
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const label = clean(element.labels?.[0]?.textContent)
    if (label !== '') return label
    if (!(element instanceof HTMLSelectElement) && element.placeholder !== '') {
      return clean(element.placeholder)
    }
    return clean(element.name)
  }
  const text = clean(element.textContent)
  if (text !== '' && text.length < 40) return text
  return firstText(element) || clean(element.getAttribute('title'))
}

const ACTIONABLE = [
  'button',
  'a[href]',
  'summary',
  'select',
  'textarea',
  'input',
  'label',
  'tr',
  'li',
  'dialog',
  '[role]',
].join(',')

const ROLE_OF_TAG: Record<string, string> = {
  a: 'link',
  tr: 'row',
  li: 'item',
}

function describe(target: Element): string {
  if (target instanceof HTMLDialogElement) return 'dialog backdrop'
  const element = target.closest(ACTIONABLE) ?? target
  const tag = element.tagName.toLowerCase()
  const role =
    element.getAttribute('role') ??
    (element instanceof HTMLInputElement ? element.type : (ROLE_OF_TAG[tag] ?? tag))
  const name = elementName(element)
  return name === '' ? role : `${role} "${name}"`
}

function dialogTitle(target: Element): string | null {
  const dialog = target.closest('dialog, [role="dialog"], [role="alertdialog"]')
  if (dialog === null) return null
  const heading = dialog.querySelector('h1, h2, h3, h4')
  return (
    clean(dialog.getAttribute('aria-label')) ||
    labelledBy(dialog) ||
    clean(heading?.textContent) ||
    firstText(dialog) ||
    'dialog'
  )
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function isTextField(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type)
  return element instanceof HTMLElement && element.isContentEditable
}

/** Pickers the browser draws itself; their click only opens the picker, the change is the act. */
function isPicker(element: Element): boolean {
  return (
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLInputElement &&
      ['date', 'datetime-local', 'time', 'month', 'week', 'color', 'range', 'file'].includes(
        element.type,
      ))
  )
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])

function keyCombo(event: KeyboardEvent): string {
  const parts = [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.metaKey && 'Meta',
    event.shiftKey && event.key.length > 1 && 'Shift',
  ].filter((part): part is string => part !== false)
  return [...parts, event.key === ' ' ? 'Space' : event.key].join('+')
}

function requestOf(input: RequestInfo | URL, init?: RequestInit): { method: string; path: string } {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, location.href)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  return { method: method.toUpperCase(), path: `${url.pathname}${url.search}` }
}

/**
 * Ends a request when its body has been read, or right after the headers when
 * the caller does not read it in the same turn (status checks, streams).
 */
function trackBody(response: Response, done: (status: number) => void): void {
  let ended = false
  let reading = false
  const end = () => {
    if (ended) return
    ended = true
    done(response.status)
  }
  const wrap =
    <T>(read: () => Promise<T>) =>
    () => {
      reading = true
      return read().finally(end)
    }
  response.json = wrap(response.json.bind(response))
  response.text = wrap(response.text.bind(response))
  response.arrayBuffer = wrap(response.arrayBuffer.bind(response))
  response.blob = wrap(response.blob.bind(response))
  setTimeout(() => {
    if (!reading) end()
  }, 0)
}

let trackHubRequest: ((url: string) => ((status: number) => void) | null) | null = null

/**
 * Starts timing a GET the shared hub makes on this page's behalf (it runs in a
 * SharedWorker, outside the patched fetch). Null when no interaction is open.
 */
export function hubRequest(url: string): ((status: number) => void) | null {
  return trackHubRequest?.(url) ?? null
}

/**
 * Times every human interaction with the dashboard (clicks, key presses,
 * picker changes, typing) and uploads the samples to the Diagnostics page.
 * Patches `window.fetch` to attribute requests; call once at startup.
 */
export function installInteractionTracking(route: () => string): void {
  const originalFetch = window.fetch.bind(window)
  const url = `${apiBase}/api/diagnostics/interactions`
  let buffer: InteractionRecord[] = []
  /** keepalive caps the body at 64 KiB, so only the last flush before the page goes away uses it. */
  const flush = (keepalive = false) => {
    if (buffer.length === 0) return
    const body = JSON.stringify({ interactions: buffer })
    buffer = []
    void originalFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive,
    }).catch(() => {})
  }
  setInterval(flush, FLUSH_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })

  const tracker = new InteractionTracker({
    now: () => performance.now(),
    wallNow: () => Date.now(),
    afterPaint: (callback) => requestAnimationFrame(() => setTimeout(callback, 0)),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    emit: (record) => {
      buffer.push(record)
      if (buffer.length >= FLUSH_BATCH) flush()
    },
  })

  trackHubRequest = (hubUrl) => tracker.request('GET', requestOf(hubUrl).path)

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { method, path } = requestOf(input, init)
    const done = tracker.request(method, path)
    if (done === null) return originalFetch(input, init)
    try {
      const response = await originalFetch(input, init)
      trackBody(response, done)
      return response
    } catch (error) {
      done(0)
      throw error
    }
  }) as typeof fetch

  let lastKeyAt = Number.NEGATIVE_INFINITY
  const begin = (event: Event, kind: InteractionKind, action: string, target: Element) => {
    tracker.begin(
      { kind, action, context: dialogTitle(target), route: route(), path: location.pathname },
      event.timeStamp,
    )
  }
  const elementOf = (event: Event): Element | null =>
    event.target instanceof Element ? event.target : null

  const listen = <K extends keyof WindowEventMap>(
    type: K,
    handler: (event: WindowEventMap[K], target: Element) => void,
  ) =>
    window.addEventListener(
      type,
      (event) => {
        const target = elementOf(event)
        if (event.isTrusted && target !== null) handler(event, target)
      },
      { capture: true, passive: true },
    )

  listen('click', (event, target) => {
    // Enter or Space on a button, and Enter submitting a form, synthesize a click.
    if (event.detail === 0 && event.timeStamp - lastKeyAt < 50) return
    if (isTextField(target) || isPicker(target)) return
    const label = target.closest('label')
    if (label !== null && label.control !== null && label.control !== target) return
    begin(event, 'click', describe(target), target)
  })
  listen('keydown', (event, target) => {
    if (event.repeat || MODIFIER_KEYS.has(event.key) || event.key === 'Tab') return
    const typing = isTextField(target) || target instanceof HTMLSelectElement
    const command = event.ctrlKey || event.metaKey || event.altKey
    if (typing && !command && event.key !== 'Enter' && event.key !== 'Escape') return
    lastKeyAt = event.timeStamp
    const combo = keyCombo(event)
    const focused = target === document.body ? '' : ` on ${describe(target)}`
    begin(event, 'key', `${combo}${focused}`, target)
  })
  listen('change', (event, target) => {
    if (isPicker(target)) begin(event, 'change', describe(target), target)
  })
  listen('input', (event, target) => {
    if (isTextField(target)) begin(event, 'input', describe(target), target)
  })
}
