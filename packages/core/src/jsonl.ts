/**
 * Harnesses interleave plain text with their JSON stream (claude emits a
 * "no stdin data received" warning on stdout, for one), so anything that does
 * not parse is dropped rather than aborting the run.
 */
export async function* jsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  // Read through a reader rather than for-await: lib.dom's ReadableStream is
  // not typed as async iterable even though the runtime supports it.
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed = tryParse(line)
        if (parsed !== undefined) yield parsed
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }

  const last = tryParse(buffer)
  if (last !== undefined) yield last
}

function tryParse(line: string): unknown {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}
