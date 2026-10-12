export function watchMissingTaskProjection(
  missing: boolean,
  selected: string | null,
  resync: () => void,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setInterval> = setInterval,
  cancel: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): () => void {
  if (!missing || selected === null) return () => {}
  const timer = schedule(resync, 4000)
  return () => cancel(timer)
}
