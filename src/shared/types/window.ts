export type WindowId = 'main' | 'add-task' | 'onboarding' | 'download-confirm'

export const WindowRoutes: Record<WindowId, string> = {
  main: '?w=main',
  'add-task': '?w=add-task',
  onboarding: '?w=onboarding',
  'download-confirm': '?w=download-confirm',
} as const
