---
description: Language, bilingual public docs, and private-context boundaries
---

# Language & Documentation

## Language

- Code, comments, commits, PR titles, branches, file names, and identifiers are
  English.
- Respond to users in the language they use.

## Public Documentation

- New end-user guides and documents with an existing translated counterpart
  ship as English `<name>.md` and Chinese `<name>.zh-CN.md` pairs.
- Governance files, generated artifacts, and subtree/developer READMEs may stay
  single-language unless maintainers establish a pair.
- When editing one file in a pair, update the other in the same change. Keep
  headings, commands, paths, and code samples aligned while writing idiomatic
  prose in each language.
- `docs/` contains reviewed public artifacts, not private design material.

## Public/Private Boundary

- Machine-specific agent context belongs in ignored `CLAUDE.local.md`.
- Never commit private plans, prompts, handoffs, credentials, private
  application or vault names, or absolute local paths.
- Public contribution workflows must work from a normal checkout without a
  private account, application, or adjacent repository.
- Rewrite private source material as a standalone public artifact and review
  it before committing.

## Maintainer Documentation

- Maintainer operation manuals, deployment runbooks, internal specifications,
  and implementation plans belong in Obsidian by default. A request to prepare
  one does not authorize adding it to the repository, committing it, or
  pushing it. Put it in the repository only when the user explicitly requests
  a public repository document.
- Use the project's `pnpm docs` gateway for these documents. Invoke it as
  `pnpm run docs -- <command>` (or the `docs:*` scripts), because bare
  `pnpm docs` can resolve to pnpm's built-in package-documentation command.
  Start with `pnpm run docs -- help` and `pnpm run docs -- doctor`.
- Resolve the destination from the ignored `obsidian-docs.config.json`. In a
  new worktree, use `--config <existing-local-config>` when a configured
  checkout is available. Keep vault names and machine paths out of tracked
  rules and public documentation.
- Create documents through `pnpm run docs -- create <directory> <name.md>
  --from <temporary-file>` using a source file outside the repository. Check
  existing notes before replacing content; use `--overwrite` only for the
  intended update. Do not substitute raw vault filesystem writes or UI
  automation for this gateway.
- Read back saved content and check code blocks and literal escape sequences;
  a successful create command alone does not prove the manual is intact.
- If the gateway or configuration is unavailable, report the specific blocker
  and retain a temporary copy outside the repository. Do not fall back to
  placing the manual in `docs/` or publishing it in a PR.
