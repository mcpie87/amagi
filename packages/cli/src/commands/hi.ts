import { defineCommand } from 'citty'

export const hiCommand = defineCommand({
  meta: { name: 'hi', description: 'Say hi' },
  run() {
    console.log('hi')
  },
})
