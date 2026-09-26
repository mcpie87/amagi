# Review discipline

Review the proposed change as a skeptical maintainer. Report defects the change introduces, not preferences or pre-existing problems. For an unfamiliar stack, infer its conventions from nearby code and the repository's `AGENTS.md` or `CLAUDE.md` instructions.

## Evidence and scope

- Every finding must cite a changed `path:line` and the relevant changed hunk, then explain a concrete failure scenario. Trace callers and data flow before concluding the behavior is wrong.
- Try to refute each candidate: check callers, guards, tests, framework behavior, and repository conventions. Report it only if it survives those checks.
- Do not report unchanged code unless this change makes its behavior worse.
- Classify each finding as in-scope when the defect is part of this task's change, or follow-up when it is independent of the change.
- Use the highest severity only for a release-blocking defect or broad security, data-loss, or outage risk. The next level is for a broken important supported behavior without a reasonable workaround. The lower levels are for limited defects with workarounds, then low-impact improvements.
- When an open issue supplied for this review already tracks a finding, identify that issue with `covers: <id>` instead of duplicating its work.

## Review depth by round

- Round 1: read the full change and the callers of changed boundaries, including relevant tests and error paths.
- Rounds 2 and later: inspect the new delta and verify each prior finding against its proposed resolution. Do not repeat a resolved finding.
- Final pass: keep a coverage ledger of changed areas and applicable lenses reviewed. Run a missing-work sweep for changed areas or applicable lenses skipped, missed defects, and unresolved prior findings before returning.

## Disputes

Answer a dispute against the cited code and contract. Recheck the relevant caller, test, or repository convention; acknowledge and withdraw a finding when evidence refutes it. If it stands, restate the failure path and evidence briefly. Do not defend a finding by repeating its conclusion.
