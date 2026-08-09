import { type CommandId, CommandIds } from '@shared/commands-catalog'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeCommand } from './executor'

describe('executeCommand', () => {
  const fetchMock = vi.fn()
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    window.location.hash = ''
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    warnSpy.mockRestore()
  })

  it.each([
    [CommandIds.NavigateTaskList, '#/downloads'],
    [CommandIds.AppOpenPreferences, '#/settings'],
    [CommandIds.TaskNew, '#/downloads?addTask=url'],
  ])('navigates %s to %s', async (command, hash) => {
    await executeCommand(command)
    expect(window.location.hash).toBe(hash)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [CommandIds.TaskPauseAll, '/api/tasks/pause-all'],
    [CommandIds.TaskResumeAll, '/api/tasks/resume-all'],
  ])(
    'posts %s through the authenticated control plane',
    async (command, path) => {
      await executeCommand(command)

      expect(fetchMock).toHaveBeenCalledWith(path, {
        method: 'POST',
        credentials: 'same-origin',
      })
    }
  )

  it('warns when the control-plane request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })

    await executeCommand(CommandIds.TaskPauseAll)

    expect(warnSpy).toHaveBeenCalledWith(
      '[shortcuts] /api/tasks/pause-all -> 503'
    )
  })

  it('warns when a command has no web implementation', async () => {
    const unsupported = CommandIds.AppShowAbout as CommandId

    await executeCommand(unsupported)

    expect(warnSpy).toHaveBeenCalledWith(
      "[shortcuts] command 'motrix.app.showAbout' has no web executor"
    )
  })
})
