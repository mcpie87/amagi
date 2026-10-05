import type { BeadsHealth } from '@amagi/core/beads-service'
import { fmtBytes } from '@amagi/core/format'
import { Link, useLocation, useSearch } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { manualRoute } from '../routes.tsx'
import { useDashboard } from '../store.tsx'
import { Time } from '../ui.tsx'

/** Above this a bd read is slow enough that the steps below are worth taking. */
const SLOW_MS = 300

/** URL fragment for a section title, e.g. "GitLab: project access token" -> "gitlab-project-access-token". */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section id={slug(title)} className="mb-6 max-w-3xl scroll-mt-4">
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

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-sky-ink hover:underline">
      {children}
    </a>
  )
}

type ManualPage = { id: string; title: string; sections: { title: string; body: ReactNode }[] }

const PAGES: ManualPage[] = [
  {
    id: 'beads-speed',
    title: 'Beads speed',
    sections: [
      {
        title: 'Beads speed for this repository',
        body: (
          <>
            <BeadsHealthPanel />
          </>
        ),
      },
      {
        title: 'Why bd calls are slow',
        body: (
          <>
            <p>
              Every <code>bd</code> call is a new process that starts Dolt's embedded database
              engine, replays its write journal, runs one query and exits. The query is cheap; the
              start is not. The journal grows with every write (claims, lease heartbeats, notes) and
              nothing shrinks it until a garbage collection runs.
            </p>
            <p>
              Measured on amagi's own store: a 155 MB journal cost 0.66 s per call. One GC took 1 s,
              left 48 MB and brought calls down to 0.15 s. Issues and history were untouched.
            </p>
          </>
        ),
      },
      {
        title: 'What amagi does about it',
        body: (
          <>
            <p>
              The server keeps each repository's issue reads (task lists, issue detail, the inbox)
              until the Dolt store changes, whoever changed it: amagi, your <code>bd</code> CLI or a
              sync. Claims, the ready queue, lease heartbeats and gates always ask <code>bd</code>,
              because their answers also change with time.
            </p>
            <p>
              It also runs a Dolt garbage collection per repository when the server starts and then
              hourly. Other <code>bd</code> calls wait about a second while it runs. Tune or turn it
              off in <code>.amagi/config.toml</code>:
            </p>
            <Code>{'[watchers.beadsGc]\nenabled = true\n\n[loop]\nbeadsGcIntervalSec = 3600'}</Code>
            <p>To collect by hand, the same command the server runs:</p>
            <Code>{'bd gc --skip-decay'}</Code>
            <p>
              Do not automate the rest of <code>bd gc</code> or <code>bd compact</code>: without{' '}
              <code>--skip-decay</code> it deletes closed issues older than 90 days, and compaction
              rewrites the history other clones sync against.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'beads-mode',
    title: 'Beads: embedded or server',
    sections: [
      {
        title: 'Embedded or server mode',
        body: (
          <>
            <p>
              beads keeps a repository's issues in a Dolt database inside <code>.beads/</code>.{' '}
              <code>bd</code> can open that database in one of two ways:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Embedded</strong> (the default): every <code>bd</code> call opens the
                database files itself, runs its query and exits. Nothing runs in the background.
              </li>
              <li>
                <strong>Server</strong>: a <code>dolt sql-server</code> process keeps the database
                open and <code>bd</code> talks to it over a local port. <code>bd</code> starts that
                process itself the first time it needs it.
              </li>
            </ul>
            <p>
              The mode is the <code>dolt_mode</code> line in <code>.beads/metadata.json</code>.
              Apart from that line, the two modes only differ in which folder holds the database.
              Issues, history and memories are the same Dolt database either way and move across
              unchanged, in both directions.
            </p>
            <h3 className="font-medium">Embedded: good and bad</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>Good: nothing to install besides bd, nothing to keep running, no open port.</li>
              <li>Good: amagi caches issue reads, so the dashboard rarely waits on bd.</li>
              <li>
                Bad: every call pays the engine start (0.15 s to 0.66 s measured above), and it
                grows between GCs.
              </li>
              <li>
                Bad: only one <code>bd</code> process can use the database at a time. amagi's
                workers, watchers and your own shell queue behind each other.
              </li>
            </ul>
            <h3 className="font-medium">Server: good and bad</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>Good: no engine start per call.</li>
              <li>Good: several bd calls can run at the same time.</li>
              <li>
                Bad: every machine working on this repository needs the <code>dolt</code> binary.
              </li>
              <li>
                Bad: a background process with a port, a PID file and a log in <code>.beads/</code>.
              </li>
              <li>
                Bad: amagi's read cache turns off, so every dashboard read goes to bd. amagi has not
                measured whether server mode comes out faster overall.
              </li>
              <li>
                Bad: bd turns its automatic backups off in server mode until you turn them on.
              </li>
              <li>
                Bad: <code>metadata.json</code> is committed, so once you push the switch, every
                other clone has to switch too (see "After switching").
              </li>
            </ul>
            <h3 className="font-medium">Which one to pick</h3>
            <p>
              Stay embedded unless the panel above still shows bd reads over {SLOW_MS} ms right
              after a GC, or bd calls visibly wait on each other while many workers run. Switching
              back is the same steps in reverse, so trying server mode costs little.
            </p>
          </>
        ),
      },
      {
        title: 'Before you switch (either direction)',
        body: (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Stop amagi (<code>Ctrl-C</code> on <code>amagi serve</code>, or stop its service).
                Workers, watchers and the hourly GC all call bd.
              </li>
              <li>
                Close anything else that runs <code>bd</code>: other shells, editors, a commit in
                progress (the beads git hooks call bd). This should print nothing that belongs to
                this repository:
                <Code>{"pgrep -af 'bd |dolt'"}</Code>
              </li>
              <li>
                Go to the repository root and look up the database name. The commands below use it
                as <code>$DB</code>:
                <Code>
                  {
                    'cd ~/projects/your-repo\ngrep dolt_database .beads/metadata.json\n# "dolt_database": "am"  ->  use am below\nDB=am'
                  }
                </Code>
              </li>
              <li>
                Write down how many issues and memories there are, so you can compare afterwards,
                and copy the whole <code>.beads</code> folder somewhere safe:
                <Code>
                  {'bd count\nbd memories | wc -l\ncp -a .beads ~/beads-backup-$(date +%F)'}
                </Code>
                That copy is your undo button. If anything goes wrong, stop, then:
                <Code>{'mv .beads .beads-broken\ncp -a ~/beads-backup-YYYY-MM-DD .beads'}</Code>
              </li>
            </ol>
          </>
        ),
      },
      {
        title: 'Switch from embedded to server',
        body: (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Copy the database into the folder server mode reads from:
                <Code>{'mkdir -p .beads/dolt\ncp -a .beads/embeddeddolt/$DB .beads/dolt/$DB'}</Code>
              </li>
              <li>
                Move the old embedded folder out of <code>.beads</code>. Left in place, it goes
                stale and could be mistaken for current data if you ever switch back:
                <Code>{'mv .beads/embeddeddolt ~/beads-embedded-old-$(date +%F)'}</Code>
              </li>
              <li>
                Change the mode. Either edit <code>.beads/metadata.json</code> and replace{' '}
                <code>"embedded"</code> with <code>"server"</code> on the <code>dolt_mode</code>{' '}
                line, or run:
                <Code>
                  {
                    'sed -i \'s/"dolt_mode": *"embedded"/"dolt_mode": "server"/\' .beads/metadata.json\n# macOS: sed -i \'\' \'s/.../.../\' .beads/metadata.json'
                  }
                </Code>
              </li>
              <li>
                Check it. The first command also starts the server, so it can take a few seconds.
                Both counts must match what you wrote down:
                <Code>
                  {'bd count\nbd dolt status     # Dolt server: running\nbd memories | wc -l'}
                </Code>
              </li>
              <li>
                Turn backups back on:
                <Code>{'bd config set backup.enabled true'}</Code>
              </li>
              <li>
                Start amagi again. The panel above now shows the read cache as off; that is
                expected. To keep the first bd call fast after a reboot, start the server at login
                (last section).
              </li>
            </ol>
          </>
        ),
      },
      {
        title: 'Switch from server back to embedded',
        body: (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Stop the server and make sure it is gone. If you start it at login, disable that
                service first, or it comes back:
                <Code>{'bd dolt stop\nbd dolt status     # Dolt server: not running'}</Code>
              </li>
              <li>
                Make sure no old embedded folder is left. The command should fail with "No such file
                or directory":
                <Code>{'ls .beads/embeddeddolt'}</Code>
                If the folder exists, it is stale: it is missing everything written in server mode.
                Move it out of <code>.beads</code>, do not merge it, and never copy an old embedded
                backup back in its place.
              </li>
              <li>
                Copy the database back, then move the server folder out of <code>.beads</code>:
                <Code>
                  {
                    'mkdir -p .beads/embeddeddolt\ncp -a .beads/dolt/$DB .beads/embeddeddolt/$DB\nmv .beads/dolt ~/beads-server-old-$(date +%F)'
                  }
                </Code>
              </li>
              <li>
                Change the mode back:
                <Code>
                  {
                    'sed -i \'s/"dolt_mode": *"server"/"dolt_mode": "embedded"/\' .beads/metadata.json'
                  }
                </Code>
              </li>
              <li>
                Check it. Both counts must match what you wrote down:
                <Code>
                  {'bd count\nbd dolt status     # Dolt engine: embedded\nbd memories | wc -l'}
                </Code>
              </li>
              <li>
                Delete the generated server config and start amagi again:
                <Code>{'rm .beads/dolt-server-config.yaml'}</Code>
              </li>
            </ol>
          </>
        ),
      },
      {
        title: 'After switching: git and other clones',
        body: (
          <>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <code>git status</code> shows <code>.beads/metadata.json</code> as changed. Commit
                it if every clone should use the new mode, or keep it uncommitted to try the mode on
                this machine first.
              </li>
              <li>
                In server mode, <code>git status</code> also lists{' '}
                <code>.beads/dolt-server-config.yaml</code>. bd rewrites it on every server start
                with this machine's paths and port. Do not commit it.
              </li>
              <li>
                Every other clone that pulls the new <code>metadata.json</code> has to move its own
                database the same way (the same steps, skipping the <code>sed</code> line). Until
                then its bd calls fail with <code>database "..." not found on Dolt server</code>.
                Nothing is lost: the data is still in the old folder, waiting to be copied.
              </li>
            </ul>
          </>
        ),
      },
      {
        title: 'Installing dolt and starting the server at login',
        body: (
          <>
            <p>
              Untested here. Adjust the repository path, and use absolute paths wherever{' '}
              <code>bd</code> or <code>dolt</code> is not on the service's <code>PATH</code>.
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
          </>
        ),
      },
    ],
  },
  {
    id: 'forge-tokens',
    title: 'Forge tokens',
    sections: [
      {
        title: 'What the token is for',
        body: (
          <>
            <p>
              amagi talks to a forge with one token per forge, and uses it for exactly this: read
              and comment on issues, add and remove its claim label, open and close issues (only
              when the forge is the tracker), list, read, open, comment on, label and close pull
              requests, push its own <code>amagi/&lt;task&gt;-…</code> branches and delete them once
              the pull request is closed. Nothing else: it never merges, never touches settings, CI,
              releases or other repositories.
            </p>
            <p>
              Paste the token under <strong>Settings → Repository → Forge tokens</strong>. One token
              can serve several repositories, and rotating it there updates all of them. It is
              stored in <code>$XDG_STATE_HOME/amagi/forge/tokens.json</code> (by default{' '}
              <code>~/.local/state/amagi/forge/tokens.json</code>, mode 600), never in{' '}
              <code>.amagi/config.toml</code>, which is committed. Without a stored token amagi
              falls back to <code>GH_TOKEN</code>/<code>GITHUB_TOKEN</code>,{' '}
              <code>GITLAB_TOKEN</code> or <code>FORGEJO_TOKEN</code> in its own environment. It
              never uses your own <code>gh</code>, <code>glab</code> or <code>tea</code> login.
            </p>
            <p>
              amagi does not guess which forge a repository lives on: pick GitHub, GitLab or Forgejo
              under <strong>Settings → Repository → Forge for pull requests</strong> (stored as{' '}
              <code>[forge] kind</code> in <code>.amagi/config.toml</code>, GitHub when unset). Next
              to it, <strong>Git remote</strong> (<code>[forge] remote</code>, default{' '}
              <code>origin</code>) picks the remote amagi fetches from and pushes to, and the
              repository <code>gh</code>, <code>glab</code> and <code>tea</code> work on. With
              GitHub as <code>origin</code> and GitLab as <code>gitlab</code>, pick{' '}
              <code>gitlab</code> to open merge requests there. The server address comes from that
              remote: <code>git@git.example.com:owner/repo.git</code> becomes{' '}
              <code>https://git.example.com</code>. When that is wrong, fill in the token's{' '}
              <strong>Server URL</strong> (GitLab and Forgejo only), for example when SSH runs on
              another host or port than the web UI, the instance lives under a path like{' '}
              <code>https://example.com/gitlab</code>, or it only speaks plain <code>http</code>.
            </p>
          </>
        ),
      },
      {
        title: 'General rules',
        body: (
          <>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Create the token on a <strong>dedicated bot account</strong>, not your own. A token
                can never do more than its account can, so an account that is only a collaborator on
                the repositories amagi works on caps the damage of a leaked token, and branch
                protection can single it out.
              </li>
              <li>
                Give the bot the lowest role that can push a branch: <em>Write</em> on GitHub and
                Forgejo, <em>Developer</em> on GitLab. Never admin or maintainer: those can push
                past branch protection or turn it off.
              </li>
              <li>Limit the token to the repositories amagi works on, never all repositories.</li>
              <li>
                Set an expiry (90 days or less) and rotate it in the settings page before it runs
                out.
              </li>
              <li>
                Grant only the permissions listed below. Anything missing fails loudly; add it then.
              </li>
            </ul>
          </>
        ),
      },
      {
        title: 'GitHub: fine-grained personal access token',
        body: (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Signed in as the bot, open{' '}
                <Ext href="https://github.com/settings/personal-access-tokens/new">
                  Settings → Developer settings → Fine-grained tokens → Generate new token
                </Ext>{' '}
                (
                <Ext href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token">
                  GitHub's guide
                </Ext>
                ). Do not use a classic token: its <code>repo</code> scope covers every repository
                the account can reach.
              </li>
              <li>
                <strong>Resource owner</strong>: the user or organization that owns the
                repositories. An organization may have to allow fine-grained tokens and approve this
                one first (
                <Ext href="https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization">
                  organization token policy
                </Ext>
                ).
              </li>
              <li>
                <strong>Expiration</strong>: 90 days or less.
              </li>
              <li>
                <strong>Repository access</strong>: <em>Only select repositories</em>, then pick
                them.
              </li>
              <li>
                <strong>Repository permissions</strong>, everything else stays <em>No access</em>:
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>
                    <em>Contents: Read and write</em>: push <code>amagi/…</code> branches and delete
                    them. GitHub cannot limit this to some branches; see "Protecting the default
                    branch".
                  </li>
                  <li>
                    <em>Pull requests: Read and write</em>: list, read, diff, open, comment on and
                    close pull requests.
                  </li>
                  <li>
                    <em>Issues: Read and write</em>: read and comment on issues, the claim label,
                    and labels on pull requests (GitHub labels a pull request through its issue).
                  </li>
                  <li>
                    <em>Metadata: Read-only</em>: added automatically and required.
                  </li>
                </ul>
              </li>
              <li>
                <strong>Account permissions</strong>: none.
              </li>
            </ol>
            <p>
              Leave <em>Workflows</em> off. A push that changes <code>.github/workflows/</code> is
              then rejected, which stops an agent from editing CI that runs with the repository's
              secrets. See the{' '}
              <Ext href="https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens">
                permissions reference
              </Ext>{' '}
              for what each permission covers.
            </p>
          </>
        ),
      },
      {
        title: 'GitLab: project access token',
        body: (
          <>
            <p>
              amagi uses GitLab only for merge requests; issues stay in beads. A{' '}
              <Ext href="https://docs.gitlab.com/user/project/settings/project_access_tokens/">
                project access token
              </Ext>{' '}
              is the narrowest option: GitLab creates a bot member for it that exists in one project
              only. It needs Premium on GitLab.com and works on any self-managed tier.
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                In the project, open <strong>Settings → Access tokens → Add new token</strong> (
                <code>
                  https://gitlab.com/&lt;group&gt;/&lt;project&gt;/-/settings/access_tokens
                </code>
                ).
              </li>
              <li>
                <strong>Expiration date</strong>: 90 days or less.
              </li>
              <li>
                <strong>Role</strong>: <em>Developer</em>. Developers cannot push to protected
                branches or change protection; Maintainer and Owner can.
              </li>
              <li>
                <strong>Scopes</strong>, nothing else:
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>
                    <code>api</code>: list, open, update and comment on merge requests. GitLab has
                    no narrower scope that writes merge requests; <code>read_api</code> cannot.
                  </li>
                  <li>
                    <code>write_repository</code>: push and delete branches over HTTPS.
                  </li>
                </ul>
              </li>
            </ol>
            <p>
              Without Premium on GitLab.com, create a bot user, add it to the project as{' '}
              <em>Developer</em> only, and give it a{' '}
              <Ext href="https://gitlab.com/-/user_settings/personal_access_tokens">
                personal access token
              </Ext>{' '}
              with the same two scopes and expiry (
              <Ext href="https://docs.gitlab.com/user/profile/personal_access_tokens/">
                GitLab's guide
              </Ext>
              ). A personal token reaches every project the user is a member of, so keep the bot out
              of everything else.
            </p>
          </>
        ),
      },
      {
        title: 'GitLab: without access to project settings',
        body: (
          <>
            <p>
              On an instance you do not administer, as a Developer on the project, you cannot create
              a project access token or a bot user. Ask a project Maintainer for the project access
              token above first: on self-managed GitLab any Maintainer can create one, on every
              tier, and it stays limited to one project. Failing that, create a token on your own
              account, fine-grained if your GitLab has it.
            </p>
            <h3 className="font-medium">Which kind your GitLab offers</h3>
            <p>
              Open <code>https://&lt;your-gitlab&gt;/help</code> to see the version, or just open
              the token page (step 1 below). GitLab 18.10 and later has a{' '}
              <strong>Generate token</strong> dropdown with <em>Fine-grained token</em> and{' '}
              <em>Legacy token</em> (beta in 18.10, generally available in 19.2). Older versions
              have a single <strong>Add new token</strong> button: that is a legacy token, use the
              second recipe.
            </p>

            <h3 className="font-medium">Fine-grained token (preferred)</h3>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Avatar (top right) → <strong>Edit profile</strong> → left sidebar{' '}
                <strong>Access → Personal access tokens</strong>, or go straight to{' '}
                <code>https://&lt;your-gitlab&gt;/-/user_settings/personal_access_tokens</code>.
              </li>
              <li>
                <strong>Generate token → Fine-grained token</strong>.
              </li>
              <li>
                <strong>Name</strong>: <code>amagi</code> plus the project, so you can tell tokens
                apart. <strong>Description</strong>: optional.
              </li>
              <li>
                <strong>Expiration date</strong>: 30 to 90 days out. Left empty it becomes a year.
              </li>
              <li>
                <strong>Group and project access</strong>: the option that limits the token to
                chosen projects, then pick only the project amagi works on. Not a whole group, not
                all projects.
              </li>
              <li>
                <strong>Add resource permissions</strong>: pick the resource in the left panel, the
                permission in the right one. On the <strong>Group and project</strong> tab:
                <table className="mt-2 w-full text-left text-xs">
                  <thead className="text-fg-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Resource</th>
                      <th className="py-1 pr-3 font-medium">Permissions</th>
                      <th className="py-1 font-medium">What amagi does with it</th>
                    </tr>
                  </thead>
                  <tbody className="align-top">
                    <tr>
                      <td className="py-1 pr-3">Code</td>
                      <td className="py-1 pr-3">Download, Push</td>
                      <td className="py-1">
                        fetch, push <code>amagi/…</code> branches, delete them after the merge
                        request closes
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1 pr-3">Merge Request</td>
                      <td className="py-1 pr-3">Create, Read, Update</td>
                      <td className="py-1">
                        open, list, read and diff merge requests; labels and closing are updates
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1 pr-3">Work Item</td>
                      <td className="py-1 pr-3">Create, Read</td>
                      <td className="py-1">
                        read and post merge request comments (GitLab files notes under work items)
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1 pr-3">Project</td>
                      <td className="py-1 pr-3">Read</td>
                      <td className="py-1">
                        <code>glab</code> looks the project up before it opens a merge request
                      </td>
                    </tr>
                  </tbody>
                </table>
                On the <strong>User</strong> tab: <em>User: Read</em>, which <code>glab</code> uses
                to look up who it is. Nothing on the <strong>Global</strong> tab.
              </li>
              <li>
                <strong>Generate token</strong>, and copy it now: GitLab never shows it again.
              </li>
            </ol>
            <p>
              If a call still fails, GitLab says exactly what is missing, for example{' '}
              <code>
                Access denied: This operation requires a fine-grained personal access token with the
                following project permissions: [Project: Read].
              </code>{' '}
              Add it to the token, or create a new one with it and swap it in the settings page.
              Permission tables:{' '}
              <Ext href="https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/">
                REST
              </Ext>
              ,{' '}
              <Ext href="https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_other/">
                Git
              </Ext>
              ; overview:{' '}
              <Ext href="https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/">
                fine-grained personal access tokens
              </Ext>
              .
            </p>
            <p>
              A fine-grained token only works where you do too: GitLab checks the token's permission
              and then your own role. As a Developer you still cannot push to a protected branch.
            </p>

            <h3 className="font-medium">Legacy token (older GitLab)</h3>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Same page:{' '}
                <code>https://&lt;your-gitlab&gt;/-/user_settings/personal_access_tokens</code>.
              </li>
              <li>
                <strong>Add new token</strong>, or on 18.10+{' '}
                <strong>Generate token → Legacy token</strong>.
              </li>
              <li>
                <strong>Token name</strong>: <code>amagi</code> plus the project.{' '}
                <strong>Expiration date</strong>: 30 to 90 days out.
              </li>
              <li>
                <strong>Select scopes</strong>: tick <code>api</code> and{' '}
                <code>write_repository</code>, nothing else.
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>
                    <code>api</code>: merge requests and their comments. <code>read_api</code>{' '}
                    cannot write, and GitLab has no scope in between.
                  </li>
                  <li>
                    <code>write_repository</code>: push and delete branches over HTTPS;{' '}
                    <code>api</code> does not cover git itself.
                  </li>
                </ul>
              </li>
              <li>
                <strong>Create personal access token</strong> (or <strong>Generate token</strong>),
                and copy it now.
              </li>
            </ol>
            <p>
              See{' '}
              <Ext href="https://docs.gitlab.com/user/profile/personal_access_tokens/">
                personal access tokens
              </Ext>{' '}
              and{' '}
              <Ext href="https://docs.gitlab.com/security/tokens/access_token_scopes/">
                token scopes
              </Ext>
              .
            </p>

            <h3 className="font-medium">What a token on your own account costs</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                A legacy token can do anything you can, in every project and group you belong to on
                that instance. A fine-grained one limited to one project cannot, which is why it is
                preferred.
              </li>
              <li>amagi's merge requests and comments appear under your name.</li>
              <li>
                Agents can currently get at the token (see "Can agents see the token?"). Keep the
                expiry short and revoke it on the same page if in doubt.
              </li>
              <li>
                The default branch usually stays safe: GitLab protects it out of the box, and a
                Developer cannot push to a protected branch with any token. Check under{' '}
                <strong>Code → Branches</strong>, which Developers can see: the default branch
                should carry a <em>protected</em> badge. If it does not, the token can push to it.
              </li>
            </ul>
          </>
        ),
      },
      {
        title: 'Forgejo: application token',
        body: (
          <>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Signed in as the bot, open{' '}
                <strong>Settings → Applications → Generate new token</strong> (
                <code>https://&lt;your-forgejo&gt;/user/settings/applications</code>).
              </li>
              <li>
                <strong>Repository and organization access</strong>: <em>Specific repositories</em>{' '}
                if your Forgejo offers it, then pick them; otherwise <em>All</em>, and keep the bot
                a collaborator only on those repositories.
              </li>
              <li>
                <strong>Permissions</strong>, everything else stays <em>No access</em>:
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>
                    <code>issue</code>: <em>Read and write</em>. Issues, their comments and labels,
                    and comments and labels on pull requests (Forgejo stores those on the pull
                    request's issue).
                  </li>
                  <li>
                    <code>repository</code>: <em>Read and write</em>. Pushing and deleting branches,
                    opening, reading and closing pull requests, reading reviews.
                  </li>
                </ul>
              </li>
            </ol>
            <p>
              amagi logs <code>tea</code> in with this token itself. If that login fails with a 403
              on <code>/api/v1/user</code>, your Forgejo needs <code>user: Read</code> for it, which
              a <em>Specific repositories</em> token cannot carry: create an <em>All</em> token with{' '}
              <code>issue</code>, <code>repository</code> and <code>user: Read</code>. See{' '}
              <Ext href="https://forgejo.org/docs/latest/user/token-scope/">
                Forgejo token scopes
              </Ext>
              .
            </p>
          </>
        ),
      },
      {
        title: 'Can agents see the token?',
        body: (
          <>
            <p>
              amagi keeps the token out of the agents' environment and points <code>gh</code>,{' '}
              <code>glab</code> and <code>tea</code> at empty config directories, so an agent does
              not get it by accident. That is not a wall: agents run as your OS user, so an agent
              that goes looking can still read <code>tokens.json</code>, amagi's own environment and
              the command line of a push in progress. Closing that needs a sandbox around the agent
              (tracked in <code>am-jlse</code>). Until then, the forge-side limits above and on the
              next page are what actually hold.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'default-branch',
    title: 'Protecting the default branch',
    sections: [
      {
        title: 'What pushes today',
        body: (
          <>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                amagi pushes only its own <code>amagi/&lt;task&gt;-…</code> branches, and conflict
                fixes to the head branch of the pull request it is fixing.
              </li>
              <li>
                Agents are told not to write to git, and a <code>git</code> shim on their{' '}
                <code>PATH</code> blocks commits and pushes. That is a guard rail, not a lock: an
                agent can call <code>/usr/bin/git</code> directly and push with your own SSH key or
                credential helper, not only with amagi's token.
              </li>
            </ul>
            <p>
              So the only protection an agent cannot get around today is on the forge. Turn it on
              wherever you can.
            </p>
          </>
        ),
      },
      {
        title: 'Protect the branch on the forge',
        body: (
          <>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>GitHub</strong>: a{' '}
                <Ext href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository">
                  ruleset
                </Ext>{' '}
                on the default branch with <em>Restrict updates</em>, <em>Restrict deletions</em>{' '}
                and <em>Block force pushes</em>, and the bot not on the bypass list. Needs admin on
                the repository; free for public repositories, private ones need a paid plan.
              </li>
              <li>
                <strong>GitLab</strong>: the default branch is{' '}
                <Ext href="https://docs.gitlab.com/user/project/repository/branches/protected/">
                  protected
                </Ext>{' '}
                out of the box with push allowed to Maintainers only, on every tier. A Developer
                token (above) already cannot push it; check{' '}
                <strong>Settings → Repository → Protected branches</strong> still says so.
              </li>
              <li>
                <strong>Forgejo</strong>:{' '}
                <Ext href="https://forgejo.org/docs/latest/user/protection/">branch protection</Ext>{' '}
                under <strong>Settings → Branches → Add rule</strong> for the default branch, with
                push disabled or limited to people other than the bot. Needs admin on the
                repository.
              </li>
            </ul>
          </>
        ),
      },
      {
        title: 'When you cannot protect the branch',
        body: (
          <>
            <p>
              Not every repository lets you: no admin rights, or a private GitHub repository on a
              free plan. Then:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                On GitLab, a Developer bot is enough: the built-in protection needs no admin to stay
                on.
              </li>
              <li>
                On GitHub and Forgejo, a bot with <em>Write</em> can push any unprotected branch,
                including the default one, and no token setting narrows that to some branches. Keep
                the token as narrow as above, keep it off every repository that does not need it,
                and expect the gap to close with the agent sandbox (<code>am-jlse</code>), not with
                token settings.
              </li>
            </ul>
          </>
        ),
      },
    ],
  },
]

export function ManualView() {
  const { page } = useSearch({ from: manualRoute.id })
  const hash = useLocation({ select: (location) => location.hash })
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0]

  useEffect(() => {
    if (hash === '') return
    document.getElementById(hash)?.scrollIntoView({ block: 'start' })
  }, [hash])

  if (current === undefined) return null
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Manual</h1>
          <p className="text-sm text-fg-muted">Operating notes that do not fit anywhere else.</p>
        </div>
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav className="shrink-0 md:sticky md:top-4 md:max-h-[calc(100vh-2rem)] md:w-64 md:overflow-y-auto">
          <ul className="space-y-1">
            {PAGES.map((p) => (
              <li key={p.id}>
                <details key={`${p.id}-${p.id === current.id}`} open={p.id === current.id}>
                  <summary
                    className={`cursor-pointer rounded-md px-2 py-1 text-sm ${
                      p.id === current.id
                        ? 'bg-raised font-medium text-fg'
                        : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    {p.title}
                  </summary>
                  <ul className="mt-1 mb-2 space-y-0.5 border-l border-line pl-3 ml-3">
                    {p.sections.map((section) => (
                      <li key={section.title}>
                        <Link
                          to="/manual"
                          search={{ page: p.id }}
                          hash={slug(section.title)}
                          className="block py-0.5 text-xs text-fg-muted hover:text-fg"
                        >
                          {section.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </nav>
        <article className="min-w-0 flex-1">
          <h2 className="mb-4 text-lg font-semibold">{current.title}</h2>
          {current.sections.map((section) => (
            <Section key={section.title} title={section.title}>
              {section.body}
            </Section>
          ))}
        </article>
      </div>
    </div>
  )
}
