---
description: Git commit, branch, PR, merge, and release policy
---

# Git Workflow

## Commits

Use Conventional Commits in English:

```text
<type>(<optional-scope>): <imperative summary>
```

Allowed types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`,
`ci`, and `style`. Keep the summary lowercase, without a period, and under 72
characters. Add a body for non-obvious rationale and a
`BREAKING CHANGE: ...` footer when applicable.

Do not add AI attribution or co-author trailers automatically. Preserve
trailers explicitly supplied by a contributor or required by legal policy.
Follow `commit-and-quality.md` before creating a commit.

## Branches and Pull Requests

- `main` is the protected active branch; `master` is frozen legacy code. Never
  target or merge Turbo work into `master`.
- Branch from current `main`. Use
  `<type>/<snake_case_topic>_<YYYYMMDD>`, optionally placing an issue number
  before the topic.
- Never push directly or force-push to `main`. All changes use PRs.
- Rebase a private feature branch onto `main` before review. Never rebase
  `main` or a branch shared with other contributors.
- After a rebase, update only your own feature branch with
  `git push --force-with-lease`; never use an unconditional force push.
- Keep a PR focused. Its title follows Conventional Commits; its description
  explains what, why, and how the change was verified.
- Squash merge feature PRs by default. Use a regular merge only when a release,
  hotfix, or intentionally structured refactor needs commit-level history.
- Delete merged branches.

## Release Safety

The checked-in workflows and scripts are the release authority; do not replace
them with local publishing steps.

- Set `package.json` to strict SemVer, then create a protected
  `v<package-version>` tag whose commit is on `main`. The tag and package
  versions must match; only stable and `beta` channels are supported.
- A tag push triggers `.github/workflows/release.yml`. Publishing is allowed
  only after its platform builds, isolated signing/finalization jobs,
  required signature checks, package verification, artifact assembly, and
  update-artifact validation succeed. macOS releases require signing and
  notarization; Windows releases may be explicitly finalized unsigned when
  both Authenticode secrets are absent. Disclose unsigned Windows artifacts in
  the public release notes. Manual dispatch validates the build path but does
  not sign or publish.
- Do not manually upload release files, reuse unverified artifacts, bypass
  protected environments, weaken signing-input isolation, or overwrite an
  existing immutable container tag.
- Protected stable and beta tags publish one verified amd64/arm64 Snap build
  set to `latest/edge`. Promote those exact revisions with `snap-promote.yml`
  from protected `main`; never rebuild during promotion. Stable rejects
  prereleases.
- If a release gate fails, fix the source or workflow and run the complete
  gated path again. Do not publish a partial platform set.
