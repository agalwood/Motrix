---
description: Repository-owned locations for Motrix builds, staging and acceptance artifacts
---

# Build Workspace

Run Motrix builds from a repository checkout or worktree inside the declared
Motrix workspace. Resolve the working directory and output paths before a build.

- Keep build output in the repository's existing `dist/` and `release/`
  directories.
- Keep downloaded candidate packages, unpacked staging files, build logs and
  ad hoc validation scripts in ignored repository output directories.
  Use `output/ci/<task>/` for build work and
  `output/playwright/manual/<task>/` for browser/device acceptance.
- Do not place Motrix checkouts, build roots, package staging or acceptance
  installers under `/private/tmp` or `/tmp`, including through symlinks.
- Discover build inputs from the repository and explicitly configured tools.
  Never recursively scan or copy host `/private`, `~/.ssh`, SSH private keys
  or authentication configuration as build inputs. SSH access, when needed for
  an explicitly requested device task, must stay scoped to that device's
  configured connection.
- Tool-managed caches and runtime test fixtures follow their existing tooling
  contracts; choose repository-owned locations for task-authored artifacts.
