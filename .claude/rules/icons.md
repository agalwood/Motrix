---
description: Semantic icon imports, library isolation, and tree shaking
paths: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx", "src/renderer/**/*.css", "scripts/check-boundaries.mjs", "tests/scripts/icon-*.test.ts"]
---

# Icons

## Use the semantic interface

- Import icons and their types from `@renderer/components/icons`. Use the
  exported semantic names directly, such as `SpeedUnlimitedIcon` and
  `MotrixIcon`; do not alias them back to `Rabbit` or `LucideIcon`.
- Within the renderer, only files inside `src/renderer/components/icons/`,
  including its adapter tests, may reference `lucide-react` or its subpaths.
  This covers value/type
  imports, re-exports, side-effect imports, `require()` and dynamic imports.
  Renderer consumers and their tests must use the semantic interface.
- If an icon is missing, add a semantic module and export it from the icon
  barrel before using it. Choose the name for the action or state it represents;
  keep distinct roles independently replaceable even if they share a glyph.
- Keep vendor-specific types, props and classes inside the icon implementation.
  Consumers must not depend on `.lucide-*` classes or SVG path geometry. Use
  accessible names or semantic `data-icon` identifiers when testing consumers.

## Maintain the adapter contract

- Keep `MotrixIconProps` and `createIcon` independent of icon-library types.
  Adapt a new library or custom SVG inside the icon directory. Preserve the
  SVG ref, caller props/children and the glyph's native viewBox and defaults.
- Use static glyph imports and retain `/* @__PURE__ */` on every module-level
  `createIcon(...)` call. Keep that factory free of external side effects.
  Do not import an entire icon namespace to build a runtime lookup table.
- Export wrapped semantic components from the barrel, not raw vendor glyphs.
  Keep decorative icons hidden from assistive technology; standalone meaningful
  icons need a translated accessible name.

## Validation

`pnpm run check:boundaries` rejects Lucide module references outside the icon
directory and runs in CI. When changing the adapter or its mappings, run the
focused icon component tests and `tests/scripts/icon-tree-shaking.test.ts`,
plus type checking.
When changing the import guard, run `tests/scripts/icon-import-boundary.test.ts`.
