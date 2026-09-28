import type { BeadsHealth } from '@amagi/core/beads-service'
import { fmtBytes } from '@amagi/core/format'
import { type ReactNode, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { useDashboard } from '../store.tsx'
import { Time } from '../ui.tsx'

/** Above this a bd read is slow enough that the steps below are worth taking. */
const SLOW_MS = 300

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 max-w-3xl">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-fg">{children}</div>
    </section>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-fg">
      {children}
    </pre>
  )
}

function BeadsHealthPanel() {
  const { selected } = useDashboard()
  const [health, setHealth] = useState<BeadsHealth | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setHealth(null)
    setError(null)
    if (selected === null) return
    let active = true
    fetch(`${apiBase}/api/repos/${selected}/beads`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<BeadsHealth>
      })
      .then((body) => {
        if (active) setHealth(body)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [selected])

  if (selected === null) return <p className="text-fg-faint">Select a repository to measure it.</p>
  if (error !== null) return <p className="text-fg-faint">{error}</p>
  if (health === null) return <p className="text-fg-faint">Measuring {selected}…</p>
  const slow = health.latencyMs !== null && health.latencyMs > SLOW_MS
  const gc = health.lastGc
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-y-1 rounded-lg border border-line bg-surface px-4 py-3">
      <dt className="text-fg-muted">bd read</dt>
      <dd className={slow ? 'text-red-ink' : 'text-emerald-ink'}>
        {health.latencyMs === null ? 'not measured' : `${Math.round(health.latencyMs)} ms`}
        <span className="text-fg-faint"> · median of {health.samples}</span>
      </dd>
      <dt className="text-fg-muted">Read cache</dt>
      <dd>{health.cached ? 'on' : 'off (not an embedded Dolt store)'}</dd>
      <dt className="text-fg-muted">Last GC</dt>
      <dd>
        {gc === null ? (
          'not run since the server started'
        ) : gc.ok ? (
          <>
            {fmtBytes(gc.sizeBeforeBytes)} → {fmtBytes(gc.sizeAfterBytes)} at <Time ts={gc.at} />
          </>
        ) : (
          <span className="text-red-ink">
            failed at <Time ts={gc.at} />: {gc.error}
          </span>
        )}
      </dd>
    </dl>
  )
}

export function ManualView() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Manual</h1>
          <p className="text-sm text-fg-muted">Operating notes that do not fit anywhere else.</p>
        </div>
      </header>

      <Section title="Beads speed for this repository">
        <BeadsHealthPanel />
      </Section>

      <Section title="Why bd calls are slow">
        <p>
          Every <code>bd</code> call is a new process that starts Dolt's embedded database engine,
          replays its write journal, runs one query and exits. The query is cheap; the start is not.
          The journal grows with every write (claims, lease heartbeats, notes) and nothing shrinks
          it until a garbage collection runs.
        </p>
        <p>
          Measured on amagi's own store: a 155 MB journal cost 0.66 s per call. One GC took 1 s,
          left 48 MB and brought calls down to 0.15 s. Issues and history were untouched.
        </p>
      </Section>

      <Section title="What amagi does about it">
        <p>
          The server keeps each repository's issue reads (task lists, issue detail, the inbox) until
          the Dolt store changes, whoever changed it: amagi, your <code>bd</code> CLI or a sync.
          Claims, the ready queue, lease heartbeats and gates always ask <code>bd</code>, because
          their answers also change with time.
        </p>
        <p>
          It also runs a Dolt garbage collection per repository when the server starts and then
          hourly. Other <code>bd</code> calls wait about a second while it runs. Tune or turn it off
          in <code>.amagi/config.toml</code>:
        </p>
        <Code>{'[watchers.beadsGc]\nenabled = true\n\n[loop]\nbeadsGcIntervalSec = 3600'}</Code>
        <p>To collect by hand, the same command the server runs:</p>
        <Code>{'bd gc --skip-decay'}</Code>
        <p>
          Do not automate the rest of <code>bd gc</code> or <code>bd compact</code>: without{' '}
          <code>--skip-decay</code> it deletes closed issues older than 90 days, and compaction
          rewrites the history other clones sync against.
        </p>
      </Section>

      <Section title="If it is still slow: a Dolt server">
        <p>
          In server mode a long-running <code>dolt sql-server</code> holds the database open, so a{' '}
          <code>bd</code> call no longer pays the engine start. amagi has not measured this yet, and
          its read cache turns itself off in server mode. Before switching:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <code>.beads/metadata.json</code> is committed, so the switch applies to every clone and
            every amagi worktree, not just this machine.
          </li>
          <li>
            There is no in-place switch. Back up with <code>bd backup</code>, then re-initialise
            following <code>bd init --help</code> (<code>--server</code>) and{' '}
            <code>bd help init-safety</code>.
          </li>
          <li>
            Every machine needs the <code>dolt</code> binary. <code>bd</code> starts the server
            itself on first use (a per-project port, PID and logs in <code>.beads/</code>), so
            starting it at login only moves that first start out of the way.
          </li>
        </ul>
      </Section>

      <Section title="Installing dolt and starting the server at login">
        <p>
          Untested here. Adjust the repository path, and use absolute paths wherever <code>bd</code>{' '}
          or <code>dolt</code> is not on the service's <code>PATH</code>.
        </p>
        <h3 className="font-medium">Linux (systemd user service)</h3>
        <Code>
          {
            '# ~/.config/systemd/user/beads-amagi.service\n[Unit]\nDescription=beads Dolt server for amagi\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=bd -C %h/projects/amagi dolt start\nExecStop=bd -C %h/projects/amagi dolt stop\n\n[Install]\nWantedBy=default.target\n\n# then: systemctl --user enable --now beads-amagi'
          }
        </Code>
        <h3 className="font-medium">NixOS / home-manager</h3>
        <Code>
          {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Nix interpolation, shown verbatim.
            '# assumes bd is installed through home.packages too\nhome.packages = [ pkgs.dolt ];\nsystemd.user.services.beads-amagi = let\n  bin = "${config.home.profileDirectory}/bin";\nin {\n  Unit.Description = "beads Dolt server for amagi";\n  Service = {\n    Type = "oneshot";\n    RemainAfterExit = true;\n    Environment = "PATH=${bin}";\n    ExecStart = "${bin}/bd -C %h/projects/amagi dolt start";\n    ExecStop = "${bin}/bd -C %h/projects/amagi dolt stop";\n  };\n  Install.WantedBy = [ "default.target" ];\n};'
          }
        </Code>
        <h3 className="font-medium">macOS (launchd)</h3>
        <Code>
          {
            'brew install dolt\n\n# ~/Library/LaunchAgents/dev.beads.amagi.plist\n<plist version="1.0"><dict>\n  <key>Label</key><string>dev.beads.amagi</string>\n  <key>ProgramArguments</key>\n  <array><string>bd</string><string>-C</string><string>/Users/you/projects/amagi</string><string>dolt</string><string>start</string></array>\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n\n# then: launchctl load ~/Library/LaunchAgents/dev.beads.amagi.plist'
          }
        </Code>
        <h3 className="font-medium">Windows (Task Scheduler)</h3>
        <Code>
          {
            'choco install dolt\nschtasks /create /sc onlogon /tn beads-amagi /tr "bd -C C:\\projects\\amagi dolt start"'
          }
        </Code>
      </Section>
    </div>
  )
}
