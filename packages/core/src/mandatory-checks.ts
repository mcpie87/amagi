import { changedCheckTooling } from './check-tooling.ts'
import type { Config } from './config.ts'
import { errMsg } from './errors.ts'
import type { CheckResult } from './events.ts'
import type { Exec } from './exec.ts'

export function configuredCheckCommands(checks: Config['checks']): string[] {
  return [...new Set([checks.format, checks.lint, checks.test, ...checks.commands])].filter(
    (command): command is string => command !== null && command !== '',
  )
}

export async function runMandatoryWorkerChecks(
  exec: Exec,
  cwd: string,
  checks: Config['checks'],
  baseRef: string,
  preparedMerge = false,
): Promise<CheckResult[]> {
  try {
    const changed = await changedCheckTooling(cwd, exec, baseRef, preparedMerge)
    if (changed.length > 0)
      return [
        {
          command: 'amagi check-tooling guard',
          exitCode: 1,
          output: `check tooling files changed:\n${changed.join('\n')}`,
        },
      ]
  } catch (error) {
    return [{ command: 'amagi check-tooling guard', exitCode: 1, output: errMsg(error) }]
  }
  const results: CheckResult[] = []
  for (const command of configuredCheckCommands(checks)) {
    const result = await exec(['sh', '-c', command], {
      cwd,
      timeoutMs: checks.timeoutSec * 1000,
    })
    results.push({
      command,
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`.slice(-8000),
    })
    if (result.exitCode !== 0) break
  }
  return results
}
