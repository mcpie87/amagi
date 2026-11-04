---
status: accepted
---

# Task stages are derived, not set

The dashboard showed the same work twice: a tracker-status board on `/issues`
and a run-state board on `/board`, with separate detail pages. They merge into
one task surface grouped by stage: Backlog, Ready, Running, Review, Needs you,
PR open and Done.

A task's stage is a pure function of its tracker status and its projected run
state, defined once in core and shared by every UI. The operator never sets a
stage directly, so cards cannot be dragged between columns. A stage changes
only when amagi advances the task or the operator takes an explicit action
(run now, set priority, unblock, answer, reset, cancel), each of which maps to
a tracker write or an orchestrator command.

## Considered Options

Drag-to-move, as in Jira or GitHub Projects, was rejected. Most stages belong
to amagi: dropping a card into Review or PR open has no meaning, and a stage
the operator can set would drift from the run state it is supposed to reflect.
Drag limited to reordering priority within Ready was also rejected; priority
keys do the same without a second interaction model.
