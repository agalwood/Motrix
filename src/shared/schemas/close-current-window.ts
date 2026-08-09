import { z } from 'zod'

/**
 * Optional payload for Commands.CloseCurrentWindow.
 *
 * - `showMain`: focus the main window after closing the current one
 *   (used when the closing window was a child like `add-task`).
 * - `navigateMainTo`: when set, emit Events.NavigateTo with this path
 *   after showing main. Must be an absolute in-app route (`/...`) so
 *   a malformed value cannot push a non-route string into the main
 *   window's React Router. Lets a child window atomically close + ask
 *   the main window's React Router to switch routes.
 *
 * Both fields are optional so legacy callers passing `undefined`
 * keep working unchanged. The handler is responsible for normalizing
 * `undefined` to `{}` before parsing — `.default({})` is intentionally
 * NOT used here so callers can't rely on schema-level defaulting in
 * one place and an explicit `?? {}` in another.
 */
export const closeCurrentWindowSchema = z.object({
  showMain: z.boolean().optional(),
  navigateMainTo: z.string().min(1).startsWith('/').optional(),
})

export type CloseCurrentWindowPayload = z.infer<typeof closeCurrentWindowSchema>
