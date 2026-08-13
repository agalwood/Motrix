---
description: Renderer component, transport, settings-form, and responsive conventions
paths: ["src/renderer/**/*.tsx", "src/renderer/**/*.ts", "src/renderer/**/*.css"]
---

# Renderer

## Component boundaries

Use the existing three layers:

1. `src/renderer/components/ui/` contains minimally adapted shadcn primitives.
2. `src/renderer/components/desktop-kit/` contains desktop interaction and
   layout wrappers such as panels, sidebars, selection, and virtual lists.
3. `src/renderer/components/settings-kit/` contains reusable settings controls
   and restart/configuration helpers.

Feature-specific composition stays with its route. Do not move domain behavior
into `ui/`, and do not bypass an existing desktop/settings wrapper by cloning it.

## State and transport

- Renderer code never imports `@core/`, `@main/`, or `@server/`. Use the
  singleton renderer transport with shared `Commands`, `Queries`, `Events`, and
  `Bridge*` constants; never raw channel strings.
- UI-only state belongs in component state or a feature-local external store.
  Core state comes from `transport.invoke(...)`; renderer mirrors are caches,
  not an independent source of truth.
- Subscribe through `transport.on()` and remove the same callback with
  `transport.off()` during cleanup. For event-backed mirrors, subscribe before
  taking the initial snapshot, guard stale async results, and refresh after
  transport reconnects so events cannot be lost across the snapshot gap.
- Coalesce, throttle, or select narrowly from high-frequency event streams to
  avoid whole-page rerenders. Use the virtual-list layer for large task/data
  collections.

## Settings forms

Settings dialogs use shadcn form components with `react-hook-form`. Reuse schemas
and defaults from `src/shared/schemas/`; use `zodResolver` when the form owns a
matching schema. Composite controls may normalize input locally and rely on the
shared/core commit-boundary schema, but must not duplicate its validation or
create renderer-only contract mirrors.

- Boolean settings use `Switch`; reserve `Checkbox` for multi-select lists.
- Dialog and batched forms persist only on Apply/submit through
  `transport.invoke(Commands.UpdateSettings, patch)`. Build the patch from dirty
  fields and preserve top-level namespaces such as `engine`, `app`, and
  `speedLimit`; never send unchanged keys accidentally.
- A standalone setting may auto-save a focused patch only when immediate save
  is explicit in that control's UX. Updating local form state does not by itself
  authorize persistence.
- Disable Apply while `formState.isSubmitting` to prevent duplicate writes.

Settings dialogs use the repository's compact density:

- `FormItem`: `flex items-start justify-between gap-4`; label/description column:
  `space-y-1`; `FormDescription`: `text-xs`.
- Every `DialogFooter` button uses `size="sm"`. Editable dialogs show Cancel
  (`outline`) then Apply (`type="submit"`); read-only dialogs show one Close.
- Follow `routes/settings/cards/downloads-dialog.tsx` and
  `advanced-dialog.tsx` when adding or restructuring a form.

## Compact headers and failure surfaces

Headers enter compact mode below `md` or when `sidebar-wrapper` is collapsed.
For style-only changes use the `compact-header:` variant defined in
`src/renderer/styles/globals.css`; do not duplicate the underlying media and
group selectors. For structural JSX changes use `useCompactHeader()` from
`components/desktop-kit/hooks/use-compact-header.ts`.

Add an Error Boundary when a new page or panel owns an independent failure
surface. Keep the boundary close enough that unrelated navigation and controls
remain usable.
