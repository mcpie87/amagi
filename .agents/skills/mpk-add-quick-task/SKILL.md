---
name: mpk-add-quick-task
description: Turn a request for tracked work into one clear, actionable Beads issue. Use when asked to add or track a task.
---

# Add a quick task

Create a durable Beads issue from the request. Use the repository's `bd` CLI.

## Before creating an issue

1. Search open and in-progress issues briefly for the same work. If one already covers it, do not create a duplicate; return that issue.
2. Check the current code or other directly relevant evidence to see whether the requested work is already done. If it is, do not create an issue; return a short explanation with the evidence.
3. Check whether the work is already in flight. If an issue already tracks it, return that issue. Otherwise capture the current progress in the new issue so it can be resumed.

Keep these checks brief and focused on the request. Do not broaden them into a general project audit.

## Interpret the request

Fill ordinary gaps with reasonable assumptions and record them in the issue. Ask a clarification question only if plausible interpretations require materially different work and choosing incorrectly would make the issue useless or harmful. The question must identify the specific choice that blocks a useful issue. Do not create an issue when asking.

## Issue format

Create exactly one issue, or update exactly one existing issue when that is the right way to capture the request. Use a concise, action-oriented title and include these sections in its description:

```markdown
## Context
Why this work is needed, including the source request when useful.

## Goal
The outcome the work should achieve.

## Scope
What should change and any relevant boundaries.

## Assumptions
Reasonable details filled in because the request did not specify them.

## Acceptance
Observable conditions that show the work is complete.
```

Do not invent unrelated requirements. Keep each section brief and specific. Verify the created or updated issue and return its URL, or its ID if no URL is available.
