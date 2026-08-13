# AGENTS.md

Claude Code rules are the canonical agent guidance for this repository. Codex
inherits them instead of maintaining a second copy.

Before inspecting or changing files, read:

1. `CLAUDE.md`.
2. Every `.claude/rules/*.md` file without `paths` frontmatter.
3. Every rule whose `paths` patterns match the files being inspected or
   changed.

If the scope expands, load the newly matching rules before continuing. Do not
load unrelated path-scoped rules by default.

Conflicts resolve in this order: current user instructions, this file,
`CLAUDE.md`, matching `.claude/rules/*.md`, then default agent behavior.
Update the canonical Claude rules rather than duplicating guidance here.
