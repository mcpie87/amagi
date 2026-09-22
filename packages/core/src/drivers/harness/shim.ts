import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateHome } from '../../paths.ts'

/**
 * Directory prepended to the harness agent's PATH. The `git` and `amagi`
 * executables here are shims that mechanically enforce the read-only git rule
 * the system prompt only states as advice.
 */
export function shimDir(): string {
  return join(stateHome(), 'amagi', 'shim', 'bin')
}

function resolveBinary(name: string): string {
  const found = Bun.which(name)
  return found ?? ''
}

/**
 * The git shim. Read verbs pass; everything else is rejected, but only when
 * the effective repository (honouring -C, --git-dir, --work-tree and cwd)
 * resolves to the task worktree or the main checkout, both read from the
 * environment so the shared script stays per-task-agnostic. Repositories
 * outside those two are passed through untouched, which is what lets the
 * project checks (`git init`/`commit` in temp dirs) keep working from inside
 * a shimmed worktree. Rejected calls append their argv to
 * `$AMAGI_RUN_STATE/rejected-git.jsonl` for the channel task to drain.
 */
function gitShimScript(realGit: string): string {
  return `#!/bin/sh
# amagi: git shim for harness agents. Read-only inside the protected worktree
# and main checkout; every other repository passes through untouched.
set -u

REAL_GIT='${realGit}'

json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

shq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"
}

reject() {
  if [ -n "\${AMAGI_RUN_STATE:-}" ]; then
    mkdir -p "$AMAGI_RUN_STATE" 2>/dev/null || true
    f="$AMAGI_RUN_STATE/rejected-git.jsonl"
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
    {
      printf '{"at":"%s","cwd":"' "$now"
      json_escape "$(pwd)"
      printf '","argv":['
      first=1
      for a in "$@"; do
        if [ "$first" -eq 1 ]; then
          first=0
        else
          printf ','
        fi
        printf '"'
        json_escape "$a"
        printf '"'
      done
      printf ']}\\n'
    } >>"$f"
  fi
  echo "amagi: git '$1' is not allowed in the task worktree or main checkout (read-only git)" >&2
  exit 1
}

# Resolves the effective repository and reports verb, top-level and the first
# argument after the verb. Runs in a subshell so the original argv is intact
# for the exec at the bottom.
resolve() {
  verb=''
  after=''
  flags=''
  while [ "$#" -gt 0 ]; do
    a="$1"
    case "$a" in
      -C)
        shift
        flags="$flags -C $(shq "$1")"
        shift
        ;;
      -C*)
        flags="$flags -C $(shq "\${a#-C}")"
        shift
        ;;
      --git-dir=*)
        flags="$flags --git-dir $(shq "\${a#--git-dir=}")"
        shift
        ;;
      --git-dir)
        shift
        flags="$flags --git-dir $(shq "$1")"
        shift
        ;;
      --work-tree=*)
        flags="$flags --work-tree $(shq "\${a#--work-tree=}")"
        shift
        ;;
      --work-tree)
        shift
        flags="$flags --work-tree $(shq "$1")"
        shift
        ;;
      -c)
        shift
        shift
        ;;
      -c*)
        shift
        ;;
      *)
        verb="$a"
        shift
        after="\${1:-}"
        break
        ;;
    esac
  done
  target=$(eval "$(shq "$REAL_GIT") $flags rev-parse --show-toplevel 2>/dev/null") || target=''
  printf '%s\\n' "$verb"
  printf '%s\\n' "$target"
  printf '%s\\n' "$after"
}

out=$(resolve "$@")
verb=$(printf '%s\\n' "$out" | sed -n '1p')
target=$(printf '%s\\n' "$out" | sed -n '2p')
after=$(printf '%s\\n' "$out" | sed -n '3p')

canon() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\\n' "$1"
}

protected=0
if [ -n "$target" ]; then
  t=$(canon "$target")
  for root in "\${AMAGI_WORKTREE:-}" "\${AMAGI_REPO_ROOT:-}"; do
    if [ -z "$root" ]; then
      continue
    fi
    r=$(canon "$root")
    if [ "$t" = "$r" ]; then
      protected=1
      break
    fi
  done
fi

if [ "$protected" -eq 1 ]; then
  allowed=0
  case "$verb" in
    status|diff|log|show|rev-parse|ls-files|blame|cat-file|describe)
      allowed=1
      ;;
    branch)
      if [ "$after" = "--list" ] || [ "$after" = "-l" ]; then
        allowed=1
      fi
      ;;
    worktree)
      if [ "$after" = "list" ]; then
        allowed=1
      fi
      ;;
  esac
  if [ "$allowed" -ne 1 ]; then
    reject "$@"
  fi
fi

exec "$REAL_GIT" "$@"
`
}

/**
 * The amagi shim: only `ask` and `git-request` reach the real binary, closing
 * `run`, `continue` and `clean` as indirect routes to git or another task
 * state. The real binary is baked in when it is on the generating PATH;
 * otherwise it is resolved at call time from PATH, skipping this shim dir.
 */
function amagiShimScript(realAmagi: string, binDir: string): string {
  return `#!/bin/sh
# amagi: shim for harness agents. Only 'ask' and 'git-request' are allowed.
set -u

REAL_AMAGI='${realAmagi}'
SHIM_BIN='${binDir}'

if [ -z "$REAL_AMAGI" ]; then
  for d in $(printf '%s' "$PATH" | tr ':' ' '); do
    [ -n "$d" ] || continue
    if [ "$d" = "$SHIM_BIN" ]; then
      continue
    fi
    if [ -x "$d/amagi" ]; then
      REAL_AMAGI="$d/amagi"
      break
    fi
  done
fi

verb="\${1:-}"
case "$verb" in
  ask|git-request) ;;
  *)
    echo "amagi: '\${verb}' is not allowed to agents; only 'ask' and 'git-request' are" >&2
    exit 1
    ;;
esac
exec "$REAL_AMAGI" "$@"
`
}

/**
 * Writes the git and amagi shims once per env-prep, mirroring prepareAgentXdg:
 * idempotent, cheap, and always fresh against the current PATH. Returns the
 * dir to prepend to PATH.
 */
export function prepareShim(): string {
  const dir = shimDir()
  mkdirSync(dir, { recursive: true })
  const git = join(dir, 'git')
  const amagi = join(dir, 'amagi')
  writeFileSync(git, gitShimScript(resolveBinary('git') || 'git'))
  writeFileSync(amagi, amagiShimScript(resolveBinary('amagi'), dir))
  chmodSync(git, 0o755)
  chmodSync(amagi, 0o755)
  return dir
}
