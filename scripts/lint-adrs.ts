// Fails when two ADRs in docs/adr share a number.
import { readdirSync } from 'node:fs'

const byNumber = new Map<string, string[]>()
for (const name of readdirSync('docs/adr')) {
  const number = /^(\d{4})-/.exec(name)?.[1]
  if (number === undefined) continue
  byNumber.set(number, [...(byNumber.get(number) ?? []), name])
}
let failed = false
for (const [number, names] of byNumber) {
  if (names.length < 2) continue
  console.error(`lint-adrs: ADR ${number} is used by ${names.join(', ')}`)
  failed = true
}
process.exit(failed ? 1 : 0)
