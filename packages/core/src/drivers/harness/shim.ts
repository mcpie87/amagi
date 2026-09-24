import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stateHome } from '../../paths.ts'

/**
 * Directory prepended to the harness agent's PATH. The `git` and `amagi`
 * executables here are shims that mechanically enforce the read-only git rule
 * the system prompt only states as advice.
 *
 * Defense-in-depth, not an enforcement boundary: an agent that resolves git by
 * absolute path or rewrites its own PATH reaches the real binary untouched.
 */
export function shimDir(): string {
  return join(stateHome(), 'amagi', 'shim', 'bin')
}

/**
 * Resolves a binary from PATH with the shim dir removed. prepareShim runs under
 * whatever PATH its own process has, and harnessEnv prepends the shim dir, so a
 * nested amagi (an agent that starts a run, a CLI launched from a shimmed shell)
 * would otherwise resolve `git` to the shim and bake it in as REAL_GIT, turning
 * every git call on the host into an endless fork chain.
 */
function resolveBinary(name: string): string {
  const shim = shimDir()
  const path = (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '' && resolve(dir) !== shim)
    .join(':')
  const found = Bun.which(name, { PATH: path })
  return found ?? ''
}

/**
 * The git shim. Read verbs pass; everything else is rejected, but only when
 * the effective repository's common git dir (honouring -C, --git-dir,
 * GIT_DIR and cwd) is the one behind the task worktree or the main checkout,
 * both read from the environment so the shared script stays
 * per-task-agnostic. It is the git dir, not the work tree, that decides:
 * opencode snapshots the worktree into its own repo with `--git-dir <own>
 * --work-tree <worktree>`, which writes nothing here and must pass, while
 * `--work-tree elsewhere` against our git dir must not. Other repositories
 * pass through untouched, which is what lets the project checks (`git
 * init`/`commit` in temp dirs) keep working from inside a shimmed worktree.
 * Rejected calls append their argv to `$AMAGI_RUN_STATE/rejected-git.jsonl`
 * for the channel task to drain.
 *
 * Defense-in-depth, not an enforcement boundary: an absolute git path or a
 * PATH without this shim dir resolves the real git. The runner diffs the
 * worktree's HEAD reflog around each agent run to catch that case.
 */
function gitShimScript(realGit: string, binDir: string): string {
  return `#!/bin/sh
# amagi: git shim for harness agents. Read-only inside the protected worktree
# and main checkout's git dir; every other repository passes through untouched.
# Defense-in-depth only: absolute paths and a rewritten PATH bypass this shim.
set -u

REAL_GIT='${realGit}'
SHIM_BIN='${binDir}'

canon_file() {
  _d=$(dirname "$1")
  _b=$(basename "$1")
  (cd "$_d" 2>/dev/null && printf '%s/%s\\n' "$(pwd -P)" "$_b") || printf '%s\\n' "$1"
}

# A REAL_GIT that points back at this script makes resolve() below run this
# script again, forking without bound until the host's pid table is full. Refuse
# to exec self under any circumstance, and rescan PATH skipping SHIM_BIN.
SELF=$(canon_file "$0")
if [ -z "$REAL_GIT" ] || [ "$(canon_file "$REAL_GIT")" = "$SELF" ]; then
  REAL_GIT=''
  for d in $(printf '%s' "$PATH" | tr ':' ' '); do
    if [ -z "$d" ] || [ "$d" = "$SHIM_BIN" ]; then
      continue
    fi
    if [ -x "$d/git" ] && [ "$(canon_file "$d/git")" != "$SELF" ]; then
      REAL_GIT="$d/git"
      break
    fi
  done
fi

if [ -z "$REAL_GIT" ]; then
  echo "amagi: git shim found no real git outside $SHIM_BIN; refusing to run" >&2
  exit 127
fi

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

# Resolves the effective repository and reports verb, absolute common git dir
# and how many global arguments precede the verb. Runs in a subshell so the
# original argv is intact for the exec at the bottom. The common dir comes from
# rev-parse under the same -C/--git-dir/--work-tree flags and the inherited
# GIT_DIR, so a retargeted work tree cannot hide which repository is written.
resolve() {
  verb=''
  flags=''
  n=0
  while [ "$#" -gt 0 ]; do
    a="$1"
    case "$a" in
      -C)
        shift
        flags="$flags -C $(shq "$1")"
        shift
        n=$((n + 2))
        ;;
      -C*)
        flags="$flags -C $(shq "\${a#-C}")"
        shift
        n=$((n + 1))
        ;;
      --git-dir=*)
        flags="$flags --git-dir $(shq "\${a#--git-dir=}")"
        shift
        n=$((n + 1))
        ;;
      --git-dir)
        shift
        flags="$flags --git-dir $(shq "$1")"
        shift
        n=$((n + 2))
        ;;
      --work-tree=*)
        flags="$flags --work-tree $(shq "\${a#--work-tree=}")"
        shift
        n=$((n + 1))
        ;;
      --work-tree)
        shift
        flags="$flags --work-tree $(shq "$1")"
        shift
        n=$((n + 2))
        ;;
      -c|--namespace|--config-env|--attr-source|--super-prefix)
        shift
        shift
        n=$((n + 2))
        ;;
      --version|--help|--exec-path|--html-path|--man-path|--info-path)
        verb="$a"
        break
        ;;
      -*)
        shift
        n=$((n + 1))
        ;;
      *)
        verb="$a"
        break
        ;;
    esac
  done
  common=$(eval "$(shq "$REAL_GIT") $flags rev-parse --path-format=absolute --git-common-dir 2>/dev/null") || common=''
  printf '%s\\n' "$verb"
  printf '%s\\n' "$common"
  printf '%s\\n' "$n"
}

canon() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\\n' "$1"
}

# The common git dir behind a protected root, ignoring any GIT_DIR the caller
# exported, which would otherwise override -C and report the caller's repo.
root_common() {
  (
    unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
    "$REAL_GIT" -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
  )
}

# Succeeds when verb "$1" with arguments "$2..." only reads the repository.
read_only() {
  v="\${1:-}"
  shift
  case "$v" in
    ''|status|diff|diff-tree|diff-files|diff-index|log|show|show-ref|rev-parse|rev-list|\\
    ls-files|ls-tree|blame|cat-file|describe|merge-base|for-each-ref|grep|shortlog|\\
    name-rev|range-diff|check-ignore|check-attr|var|version|help|--version|--help|\\
    --exec-path|--html-path|--man-path|--info-path)
      return 0
      ;;
    branch|tag)
      listing=0
      for x in "$@"; do
        case "$x" in
          -l|--list) listing=1 ;;
          --show-current|-a|--all|-r|--remotes|-v|-vv|--verbose|--column|--no-column|\\
          --format=*|--sort=*|--color|--color=*|--no-color) ;;
          -*) return 1 ;;
          *) [ "$listing" -eq 1 ] || return 1 ;;
        esac
      done
      return 0
      ;;
    remote)
      case "\${1:-}" in
        ''|-v|--verbose|get-url|show) return 0 ;;
      esac
      ;;
    config)
      case "\${1:-}" in
        --get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list) return 0 ;;
      esac
      if [ "$#" -eq 1 ]; then
        case "$1" in
          -*) ;;
          *) return 0 ;;
        esac
      fi
      ;;
    stash)
      case "\${1:-}" in
        list|show) return 0 ;;
      esac
      ;;
    reflog)
      case "\${1:-}" in
        ''|show|-*) return 0 ;;
      esac
      ;;
    worktree)
      [ "\${1:-}" = "list" ] && return 0
      ;;
  esac
  return 1
}

# Drops the global arguments before the verb, then judges verb and the rest.
verb_is_read_only() {
  skip="$1"
  shift
  shift "$skip"
  read_only "$@"
}

out=$(resolve "$@")
common=$(printf '%s\\n' "$out" | sed -n '2p')
skip=$(printf '%s\\n' "$out" | sed -n '3p')

protected=0
if [ -n "$common" ]; then
  c=$(canon "$common")
  for root in "\${AMAGI_WORKTREE:-}" "\${AMAGI_REPO_ROOT:-}"; do
    if [ -z "$root" ]; then
      continue
    fi
    rc=$(root_common "$root") || continue
    if [ -n "$rc" ] && [ "$c" = "$(canon "$rc")" ]; then
      protected=1
      break
    fi
  done
fi

if [ "$protected" -eq 1 ] && ! verb_is_read_only "\${skip:-0}" "$@"; then
  reject "$@"
fi

exec "$REAL_GIT" "$@"
`
}

/**
 * The amagi shim: only `ask` and `git-request` reach the real binary, closing
 * `run`, `continue` and `clean` as indirect routes to git or another task
 * state. The real binary is baked in when it is on the generating PATH;
 * otherwise it is resolved at call time from PATH, skipping this shim dir.
 * Like the git shim this is defense-in-depth: an absolute path or a rewritten
 * PATH bypasses it.
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
  writeFileSync(git, gitShimScript(resolveBinary('git'), dir))
  writeFileSync(amagi, amagiShimScript(resolveBinary('amagi'), dir))
  chmodSync(git, 0o755)
  chmodSync(amagi, 0o755)
  return dir
}
