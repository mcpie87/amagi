import type { CheckResult } from './events.ts'
import type { Exec } from './exec.ts'

export const MANDATORY_WORKER_CHECKS = ['just check', 'just fresh-check'] as const

export async function runMandatoryWorkerChecks(exec: Exec, cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const command of MANDATORY_WORKER_CHECKS) {
    const result = await exec(['sh', '-c', command], { cwd })
    results.push({
      command,
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`.slice(-8000),
    })
    if (result.exitCode !== 0) break
  }
  return results
}
