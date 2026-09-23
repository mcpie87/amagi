import { type AgentLogLine, agentLogStore } from '@amagi/core/agent-log'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EmptyState, Time } from './ui.tsx'

const ROW_HEIGHT = 18
// how close to the bottom counts as "at the bottom" for autoscroll purposes
const STICK_THRESHOLD = ROW_HEIGHT * 2

const kindClass: Record<AgentLogLine['kind'], string> = {
  text: 'text-fg',
  reasoning: 'text-fg-faint italic',
  tool_use: 'text-sky-ink',
  tool_result: 'text-fg-muted',
  usage: 'text-fg-dim',
  context: 'text-fg-dim',
  result: 'text-emerald-ink',
  error: 'text-red-ink',
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
  const [following, setFollowing] = useState(true)

  useSyncExternalStore(
    (listener) => agentLogStore.subscribe(logKey, listener),
    () => agentLogStore.get(logKey).version,
  )
  const buffer = agentLogStore.get(logKey)
  const lastTs = buffer.at(buffer.length - 1)?.ts

  const rowVirtualizer = useVirtualizer({
    count: buffer.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  })

  useEffect(() => {
    void buffer.version
    if (!stickToBottom.current || buffer.length === 0) return
    rowVirtualizer.scrollToIndex(buffer.length - 1, { align: 'end' })
  }, [buffer.version, buffer.length, rowVirtualizer])

  const handleScroll = () => {
    const el = parentRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    setFollowing(stickToBottom.current)
  }

  if (buffer.length === 0)
    return (
      <EmptyState icon="agent" title="Waiting for agent output">
        Live output will appear here when the agent starts working.
      </EmptyState>
    )

  return (
    <div>
      <div className="agent-log-header">
        <span>
          {buffer.length} buffered lines
          {lastTs !== undefined && (
            <span className="agent-log-last">
              last activity <Time ts={lastTs} />
            </span>
          )}
        </span>
        <button
          type="button"
          aria-pressed={following}
          onClick={() => {
            stickToBottom.current = !following
            setFollowing(!following)
            if (!following) rowVirtualizer.scrollToIndex(buffer.length - 1, { align: 'end' })
          }}
        >
          {following ? 'Following output' : 'Follow output'}
        </button>
      </div>
      <div ref={parentRef} onScroll={handleScroll} className="agent-log-scroll">
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
