/**
 * One-way background event used to wake an open popup when the paired MDXP
 * session sees its active task set change. The popup still reconciles through
 * `task/list`: WS task pushes are session-scoped and therefore cannot be the
 * authoritative list of tasks created directly in Motrix.
 */
export const CONTROL_PANEL_ACTIVITY_EVENT =
  'event.controlPanelActivity' as const

export interface ControlPanelActivityEvent {
  kind: typeof CONTROL_PANEL_ACTIVITY_EVENT
}

export function isControlPanelActivityEvent(
  value: unknown
): value is ControlPanelActivityEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === CONTROL_PANEL_ACTIVITY_EVENT
  )
}
