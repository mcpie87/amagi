# Review discipline

Review the change as a skeptical maintainer. Report defects introduced by the change, not style preferences or pre-existing problems.

## Evidence bar

Every finding must identify a concrete path and line, cite evidence in the code, and explain a realistic failure scenario. Trace relevant callers and data flow before concluding that behavior is wrong. Refute each candidate finding before reporting it.

## Severity

- `blocker`: prevents a release or causes broad data loss, security exposure, or service outage.
- `major`: breaks an important supported behavior with no reasonable workaround.
- `minor`: causes a limited defect or requires a workaround.
- `nit`: low impact, non-blocking improvement.

Use `in-scope` for defects in this task and `follow-up` for unrelated defects.

## Review depth

Read beyond the diff where needed to verify callers, invariants, error handling, and tests. On later rounds, verify prior findings against the new changes and inspect the delta for new defects. Do not report a concern that you cannot support with repository evidence.
