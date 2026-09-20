import { render } from 'ink'
import { createElement } from 'react'
import { App } from './App.tsx'

export type TuiOptions = { baseUrl: string }

export type TuiInstance = {
  unmount(): void
  waitUntilExit(): Promise<void>
}

/** Boots the Ink terminal view against a running `amagi serve` instance. */
export function renderTui({ baseUrl }: TuiOptions): TuiInstance {
  const instance = render(createElement(App, { baseUrl }))
  return {
    unmount: instance.unmount,
    waitUntilExit: () => instance.waitUntilExit().then(() => {}),
  }
}

export { App } from './App.tsx'
export { parseSseChunk, subscribeToStream } from './stream.ts'
