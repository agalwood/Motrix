import { type CommandId, CommandIds } from '@shared/commands-catalog'

async function post(path: string): Promise<void> {
  // The /api control-plane routes require the operator session cookie (Spec 9);
  // same-origin is the fetch default but be explicit.
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin' })
  if (!res.ok) {
    console.warn(`[shortcuts] ${path} -> ${res.status}`)
  }
}

export async function executeCommand(id: CommandId): Promise<void> {
  switch (id) {
    case CommandIds.NavigateTaskList:
      window.location.hash = '#/downloads'
      return
    case CommandIds.AppOpenPreferences:
      window.location.hash = '#/settings'
      return
    case CommandIds.TaskNew:
      window.location.hash = '#/downloads?addTask=url'
      return
    case CommandIds.TaskPauseAll:
      await post('/api/tasks/pause-all')
      return
    case CommandIds.TaskResumeAll:
      await post('/api/tasks/resume-all')
      return
    default:
      console.warn(`[shortcuts] command '${id}' has no web executor`)
  }
}
