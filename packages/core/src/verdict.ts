/**
 * What an agent's summary says should happen next. Every summary a worker
 * writes carries exactly one `Verdict: <label>` line so the operator can act on
 * a parked task without reading the prose. The prompt vocabulary and the parser
 * both derive from VERDICTS: a label the prompt does not show can never be
 * chosen (see docs/adr/0002 for the same trap with mention kinds).
 */
export const VERDICTS = [
  { label: 'review', meaning: 'the changes are complete; review and merge the pull request' },
  {
    label: 'close-task',
    meaning: 'the task is already done, obsolete or not needed; close the issue',
  },
  {
    label: 'new-tasks',
    meaning:
      'the work is bigger than or different from the task; file the follow-up tasks you list',
  },
  {
    label: 'postpone',
    meaning: 'blocked on another task, a release or an external change; retry later',
  },
  {
    label: 'rewrite-task',
    meaning: 'the task is unclear, wrong or contradicts the code; a human must rewrite it',
  },
  {
    label: 'close-pr',
    meaning: 'the pull request should be closed unmerged (wrong approach or superseded)',
  },
  { label: 'needs-human', meaning: 'a decision only the operator can make; say which one' },
] as const

export type Verdict = (typeof VERDICTS)[number]['label']

const LABELS: readonly string[] = VERDICTS.map((v) => v.label)

/** The verdicts a viability check may reach: no pull request exists yet to review or close. */
export const NOT_VIABLE_VERDICTS: readonly Verdict[] = [
  'close-task',
  'new-tasks',
  'postpone',
  'rewrite-task',
  'needs-human',
]

/** Stands in when the agent never classified its outcome: a human must look. */
export const FALLBACK_VERDICT: Verdict = 'needs-human'

/** Tolerates markdown decoration the agent may add: `**Verdict:** \`close-task\``. */
const VERDICT_LINE = /^[ \t>*_-]*verdict[ \t*_]*:[ \t*_`]*([a-z-]+)[ \t*_`.]*$/im

/** Prompt lines teaching the verdict vocabulary, for any prompt that asks for a summary. */
export function verdictPromptLines(): string[] {
  return [
    'Your message must contain exactly one line of the form `Verdict: <label>`, where',
    '<label> is the one that best says what should happen next:',
    ...VERDICTS.map((v) => `- \`${v.label}\`: ${v.meaning}`),
  ]
}

/** The verdict a summary carries, or null when it has no line with a known label. */
export function parseVerdict(text: string | null | undefined): Verdict | null {
  const label = text?.match(VERDICT_LINE)?.[1]?.toLowerCase()
  return label !== undefined && LABELS.includes(label) ? (label as Verdict) : null
}

/**
 * The summary normalized to lead with its verdict line, so the reason shown
 * for a parked task always opens with the classification. A summary with no
 * recognizable verdict gets `fallback`.
 */
export function withVerdictLine(text: string, fallback: Verdict = FALLBACK_VERDICT): string {
  const verdict = parseVerdict(text) ?? fallback
  const body = text.replace(VERDICT_LINE, '').trim()
  return body === '' ? `Verdict: ${verdict}` : `Verdict: ${verdict}\n\n${body}`
}
