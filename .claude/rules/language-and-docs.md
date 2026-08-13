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
