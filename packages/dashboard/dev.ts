import { readFileSync } from 'node:fs'
import { operatorSessionPath } from '@amagi/core/paths'
import { createServer } from 'vite'
import { SESSION_COOKIE } from '../server/src/access.ts'

const dashboard = await createServer({
  root: import.meta.dir,
  plugins: [
    {
      name: 'amagi-dev-session',
      configureServer(server) {
        server.middlewares.use('/api/auth-status', (req, res, next) => {
          if (req.method === 'GET') {
            try {
              const session = JSON.parse(readFileSync(operatorSessionPath(), 'utf8')) as {
                secret?: unknown
                port?: unknown
              }
              if (
                typeof session.secret === 'string' &&
                /^[a-f0-9]{64}$/.test(session.secret) &&
                session.port === Number(process.env.VITE_PROXY_PORT ?? '7777')
              ) {
                req.headers.cookie = `${SESSION_COOKIE}=${session.secret}`
                res.setHeader(
                  'Set-Cookie',
                  `${SESSION_COOKIE}=${session.secret}; HttpOnly; SameSite=Strict; Path=/`,
                )
              }
            } catch {
              // The API may still be starting or restarting.
            }
          }
          next()
        })
      },
    },
  ],
})
await dashboard.listen()
dashboard.printUrls()

const api = Bun.spawn(['bun', '--watch', 'packages/cli/src/index.ts', 'serve'], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, AMAGI_DEV_DASHBOARD_URL: dashboard.resolvedUrls?.local[0] },
})

let stopping = false
async function stop(exitCode: number): Promise<void> {
  if (stopping) return
  stopping = true
  api.kill()
  await Promise.all([api.exited, dashboard.close()])
  process.exit(exitCode)
}

process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))
void api.exited.then((exitCode) => void stop(exitCode))
