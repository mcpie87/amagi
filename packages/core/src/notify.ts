import type { Config } from './config.ts'
import { errMsg } from './errors.ts'
import { exec as defaultExec, type Exec } from './exec.ts'

export interface Notifier {
  readonly kind: string
  notify(title: string, body: string): Promise<void>
}

/**
 * Desktop delivery is best effort: most setups have no notify-send on PATH,
 * and a missing binary must never take down the run. The dashboard and ntfy
 * are the dependable channels.
 */
export class LibnotifyNotifier implements Notifier {
  readonly kind = 'libnotify'
  private readonly run: Exec

  constructor(run: Exec = defaultExec) {
    this.run = run
  }

  async notify(title: string, body: string): Promise<void> {
    try {
      const result = await this.run(['notify-send', title, body])
      if (result.exitCode !== 0) {
        console.warn(`libnotify: notify-send exited ${result.exitCode}: ${result.stderr.trim()}`)
      }
    } catch (err) {
      const detail = errMsg(err)
      console.warn(`libnotify: notify-send unavailable: ${detail}`)
    }
  }
}

export class NtfyNotifier implements Notifier {
  readonly kind = 'ntfy'

  constructor(
    private readonly topic: string,
    private readonly server = 'https://ntfy.sh',
  ) {}

  async notify(title: string, body: string): Promise<void> {
    const res = await fetch(`${this.server}/${this.topic}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', title },
      body,
    })
    if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`)
  }
}

export function makeNotifiers(config: Config): Notifier[] {
  const notifiers: Notifier[] = []
  if (config.notify.desktop) notifiers.push(new LibnotifyNotifier())
  if (config.notify.ntfyTopic) {
    notifiers.push(new NtfyNotifier(config.notify.ntfyTopic, config.notify.ntfyServer))
  }
  return notifiers
}
