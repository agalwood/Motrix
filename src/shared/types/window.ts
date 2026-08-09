export type WindowId = 'main' | 'add-task' | 'onboarding'

export const WindowRoutes: Record<WindowId, string> = {
  main: '?w=main',
  'add-task': '?w=add-task',
  onboarding: '?w=onboarding',
} as const
