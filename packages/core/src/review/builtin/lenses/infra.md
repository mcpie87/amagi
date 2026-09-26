---
match: ["**/Dockerfile", "**/Dockerfile.*", "**/*.dockerfile", "**/.github/workflows/*.yml", "**/.github/workflows/*.yaml", "**/.gitlab-ci.yml", "**/.circleci/*.yml", "**/.circleci/*.yaml", "**/.buildkite/*.yml", "**/.buildkite/*.yaml", "**/azure-pipelines.yml", "**/bitbucket-pipelines.yml", "**/Jenkinsfile", "**/*.tf", "**/*.tfvars", "**/terraform/**"]
---
# Infrastructure and CI

- Check image and action sources are pinned to trusted versions where repository policy expects it; avoid privileged or broad credentials when narrower access works.
- Trace build and deploy steps for secret exposure in logs, arguments, artifacts, caches, and build layers.
- Verify container users, copied files, entrypoints, health checks, signal handling, and ports match runtime needs.
- Check CI triggers, permissions, branch conditions, artifact provenance, and whether skipped jobs can bypass required validation.
- Review infrastructure changes for unintended public access, destructive replacement, data loss, and state drift.
- Check resource limits, persistence, network rules, and dependencies against the workloads this change introduces.
