const writers = new Map<string, Promise<void>>()

/** Serializes watcher edits to the same PR branch, including checks and pushing. */
export async function withPrWriteLock<T>(
  root: string,
  remote: string,
  branch: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([root, remote, branch])
  const previous = writers.get(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  writers.set(key, current)
  try {
    await previous
    return await action()
  } finally {
    release()
    if (writers.get(key) === current) writers.delete(key)
  }
}
