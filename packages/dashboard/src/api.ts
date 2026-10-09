export const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

/**
 * Sets the operator session cookie every mutating request carries. A restarted
 * server issues a new secret, so this runs at boot and on each stream open.
 */
export const refreshSession = (): Promise<void> =>
  fetch(`${apiBase}/api/session`).then(
    () => undefined,
    () => undefined,
  )
