import {
  cancel,
  isCancel,
  type Option,
  select as selectPrompt,
  text as textPrompt,
} from '@clack/prompts'
import { orderOptions, recordPick } from './pick-history.ts'
import type { Picker, SelectOption } from './select-run.ts'

/** True when stdin is a real terminal, so interactive prompts are safe. */
export function interactive(): boolean {
  return process.stdin.isTTY === true
}

/**
 * Aborts the whole run on ctrl+c. clack swallows the SIGINT while a prompt is
 * up, so a cancel is the only way the interrupt can surface; falling back to
 * defaults here would make `run` continue past an interrupt.
 */
function onCancel(): never {
  cancel()
  process.exit(130)
}

/** Select/text prompts backed by @clack/prompts; cancelling aborts the run. */
export const picker: Picker = {
  async select<T>(title: string, options: readonly SelectOption<T>[]): Promise<T | null> {
    const ordered = orderOptions(title, options)
    const value = await selectPrompt<T>({
      message: title,
      options: ordered.map((o) => ({ value: o.value, label: o.label }) as Option<T>),
    })
    if (isCancel(value)) onCancel()
    const chosen = ordered.find((o) => o.value === value)
    if (chosen) recordPick(title, chosen.label)
    return value
  },
  async input(prompt: string): Promise<string | null> {
    const value = await textPrompt({ message: prompt })
    if (isCancel(value)) onCancel()
    return value
  },
}
