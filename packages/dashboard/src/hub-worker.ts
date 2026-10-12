import { Hub } from './hub.ts'

const hub = new Hub((import.meta.env.VITE_API_BASE ?? '') as string)

addEventListener('connect', (event) => {
  const port = (event as MessageEvent).ports[0]
  if (port !== undefined) hub.attach(port)
})
