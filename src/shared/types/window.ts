export type WindowId = 'main' | 'add-task' | 'onboarding' | 'create-torrent'

export const WindowRoutes: Record<WindowId, string> = {
  main: '?w=main',
  'add-task': '?w=add-task',
  'create-torrent': '?w=create-torrent',
  onboarding: '?w=onboarding',
} as const
