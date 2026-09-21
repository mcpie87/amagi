/**
 * Upper bound on concurrent task runs; shared by config, API and dashboard.
 * Kept in its own module, free of Node builtins, so client bundles (e.g. the
 * Vite dev server) can import it without dragging in server-only code.
 */
export const MAX_PARALLEL = 16
