import { Workspaces } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red, table } from '../format.ts'

export const reposCommand = defineCommand({
  meta: { name: 'repos', description: 'List registered repositories and their readiness' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON only', default: false },
  },
  async run({ args }) {
    const workspaces = new Workspaces()
    const entries = workspaces.list()
    if (entries.length === 0) {
      console.log(dim('no repositories registered; add one with: amagi add <path>'))
      return
    }
    if (args.json) {
      const out = []
      for (const entry of entries) {
        out.push({ ...entry, ready: await workspaces.diagnose(entry) })
      }
      console.log(JSON.stringify(out, null, 2))
      return
    }
    const rows: string[][] = [['STATUS', 'KEY', 'PATH']]
    for (const entry of entries) {
      const ready = await workspaces.diagnose(entry)
      const ok = ready.every((d) => d.ok)
      rows.push([ok ? 'ready' : 'needs work', entry.key, entry.path])
    }
    console.log(
      table(rows, (row, i) => {
        if (i === 0) return row.map(bold)
        const paint = row[0] === 'ready' ? green : red
        return row.map((c, j) => (j === 0 ? paint(c) : c))
      }),
    )
  },
})
