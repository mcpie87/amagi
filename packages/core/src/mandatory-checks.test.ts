import { expect, test } from 'bun:test'
import { projectCommandEnv } from './drivers/harness/sandbox.ts'

test('runs configured checks without inherited credentials or desktop keyring sockets', () => {
  const env = projectCommandEnv({
    GH_TOKEN: 'forge-secret',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  })

  expect(env.GH_TOKEN).toBe('')
  expect(env.SSH_AUTH_SOCK).toBe('')
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('')
})
