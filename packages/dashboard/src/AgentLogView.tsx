import { type AgentLogLine, agentLogStore } from '@amagi/core/agent-log'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useSyncExternalStore } from 'react'

const ROW_HEIGHT = 18
// how close to the bottom counts as "at the bottom" for autoscroll purposes
const STICK_THRESHOLD = ROW_HEIGHT * 2

const kindClass: Record<AgentLogLine['kind'], string> = {
  text: 'text-zinc-200',
  reasoning: 'text-zinc-500 italic',
  tool_use: 'text-sky-400',
  tool_result: 'text-zinc-400',
  usage: 'text-zinc-600',
  result: 'text-emerald-400',
  error: 'text-red-400',
}

/**
 * Renders a task's live agent log from the ring buffer in agentLog.ts. Reads
 * the buffer directly on every render instead of holding lines in React
 * state; useSyncExternalStore only forces a render when the store's
 * rAF-batched flush bumps the buffer's version, so a burst of appended lines
 * costs one re-render, not one per line. Rows outside the viewport are never
 * mounted, via @tanstack/react-virtual.
 */
export function AgentLogView({ repo, taskId }: { repo: string; taskId: string }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // namespaced by repo so identical issue ids across repos never share a buffer
  const logKey = `${repo}/${taskId}`

  useSyncExternalStore(
    (listener) => agentLogStore.subscribe(logKey, listener),
    () => agentLogStore.get(logKey).version,
  )
  const buffer = agentLogStore.get(logKey)

  const rowVirtualizer = useVirtualizer({
    count: buffer.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  })

  useEffect(() => {
    if (!stickToBottom.current || buffer.length === 0) return
    rowVirtualizer.scrollToIndex(buffer.length - 1, { align: 'end' })
  }, [buffer.version, buffer.length, rowVirtualizer])

  const handleScroll = () => {
    const el = parentRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
  }

  if (buffer.length === 0) return null

  return (
    <div className="mt-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Agent log
      </h2>
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="h-96 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-xs leading-[18px]"
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((item) => {
            const line = buffer.at(item.index)
            if (!line) return null
            return (
              <div
                key={line.id}
                data-index={item.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
                className={`truncate whitespace-pre px-3 ${kindClass[line.kind]}`}
              >
                {line.text === '' ? ' ' : line.text}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
