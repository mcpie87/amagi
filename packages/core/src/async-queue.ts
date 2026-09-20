/**
 * Single producer, single consumer. The producer pumps eagerly so a run still
 * completes when nobody is iterating the events.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiting: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const buffered = this.items.shift()
      if (buffered !== undefined) {
        yield buffered
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}
