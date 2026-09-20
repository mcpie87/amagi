import {
  cancel,
  isCancel,
  type Option,
  select as selectPrompt,
  text as textPrompt,
} from '@clack/prompts'
import type { Picker, SelectOption } from './select-run.ts'

/** True when stdin is a real terminal, so interactive prompts are safe. */
export function interactive(): boolean {
  return process.stdin.isTTY === true
}

/** Select/text prompts backed by @clack/prompts; cancelling yields null. */
export const picker: Picker = {
  async select<T>(title: string, options: readonly SelectOption<T>[]): Promise<T | null> {
    const value = await selectPrompt<T>({
      message: title,
      options: options.map((o) => ({ value: o.value, label: o.label }) as Option<T>),
    })
    if (isCancel(value)) {
      cancel()
      return null
    }
    return value
  },
  async input(prompt: string): Promise<string | null> {
    const value = await textPrompt({ message: prompt })
    if (isCancel(value)) {
      cancel()
      return null
    }
    return value
  },
}
