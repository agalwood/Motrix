import { normalizeRendererRoute } from '@shared/lib/renderer-route'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  rendererFailureSchema,
  rendererProbeReplySchema,
  rendererRecoveryRequestSchema,
  rendererSurfaceReportSchema,
} from '@shared/schemas/renderer-health'
import { rendererIntentAckSchema } from '@shared/schemas/renderer-intent'
import type { WindowId } from '@shared/types/window'
import { app, dialog, ipcMain, powerMonitor, shell } from 'electron'
import { registerTrustedIpcHandler } from '../ipc/trusted-ipc'
import { i18n } from '../lib/i18n'
import { RendererDiagnostics } from './renderer-diagnostics'
import { RendererIntents } from './renderer-intents'
import { RendererSubmissions } from './renderer-submissions'
import {
  type RendererIncident,
  RendererSupervisor,
} from './renderer-supervisor'
import type { WindowManager } from './window-manager'

export function createRendererRecoveryRuntime(deps: {
  windows(): WindowManager
  logDirectory: string
  isMagnetSelectionPending(taskId: string): boolean
}) {
  const submissions = new RendererSubmissions()
  const diagnostics = new RendererDiagnostics(deps.logDirectory)
  let promptActive = false
  const pendingPrompts = new Map<WindowId, RendererIncident>()
  const prompt = (incident: RendererIncident): void => {
    pendingPrompts.set(incident.windowId, incident)
    void showNextPrompt()
  }
  async function showNextPrompt(): Promise<void> {
    if (promptActive) return
    const next = pendingPrompts.entries().next().value
    if (!next) return
    const [id, incident] = next
    pendingPrompts.delete(id)
    if (!supervisor.isCurrentIncident(incident)) {
      void showNextPrompt()
      return
    }
    promptActive = true
    const leaveModal = supervisor.enterModal()
    let response = 0
    try {
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: i18n.t('rendererRecovery.title'),
        message: i18n.t('rendererRecovery.title'),
        detail: i18n.t('rendererRecovery.description'),
        buttons: [
          i18n.t('rendererRecovery.wait'),
          i18n.t('rendererRecovery.recover'),
          i18n.t('rendererRecovery.diagnostics'),
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      response = result.response
    } catch {
      /* Native feedback must never fail the application shell. */
    } finally {
      leaveModal()
      promptActive = false
    }
    if (supervisor.isCurrentIncident(incident)) {
      if (response === 1) supervisor.recoverManually(id)
      if (response === 2) void shell.openPath(deps.logDirectory).catch(() => {})
    }
    void showNextPrompt()
  }
  const supervisor = new RendererSupervisor({
    // Automatic recovery stays gated until the cross-platform soak is complete.
    mode: 'observe',
    reload: (id) => deps.windows().reload(id),
    recreate: (id, show) => {
      deps.windows().recreate(id, 'recovery')
      if (show) deps.windows().show(id)
    },
    normalizeRoute: normalizeRendererRoute,
    report: (incident) => diagnostics.record(incident),
    prompt,
    capabilitiesChanged: (id) => intents.flush(id),
  })
  const intents = new RendererIntents({
    window: (id) => deps.windows().get(id),
    session: (sender) => supervisor.session(sender),
    ready: (id, capability) => supervisor.hasCapability(id, capability),
    isMagnetSelectionPending: deps.isMagnetSelectionPending,
  })
  const handlers = {
    [Queries.GetRendererSession]: (event: Electron.IpcMainInvokeEvent) => ({
      ...supervisor.session(event.sender),
      submissionNeedsReview: submissions.needsReview(
        supervisor.session(event.sender).windowId,
        supervisor.session(event.sender).generation
      ),
      strings: Object.fromEntries(
        [
          'title',
          'description',
          'recovering',
          'recover',
          'diagnostics',
          'downloads',
          'failed',
          'restored',
        ].map((key) => [key, i18n.t(`rendererRecovery.${key}`)])
      ),
    }),
    [Commands.ReportRendererSurface]: (
      event: Electron.IpcMainInvokeEvent,
      raw: unknown
    ) =>
      supervisor.reportSurface(
        event.sender,
        rendererSurfaceReportSchema.parse(raw)
      ),
    [Commands.AcknowledgeRendererProbe]: (
      event: Electron.IpcMainInvokeEvent,
      raw: unknown
    ) =>
      supervisor.acknowledge(event.sender, rendererProbeReplySchema.parse(raw)),
    [Commands.ReportRendererFailure]: (
      event: Electron.IpcMainInvokeEvent,
      raw: unknown
    ) => supervisor.failure(event.sender, rendererFailureSchema.parse(raw)),
    [Commands.AcknowledgeRendererIntent]: (
      event: Electron.IpcMainInvokeEvent,
      raw: unknown
    ) => {
      const data = rendererIntentAckSchema.parse(raw)
      const id = supervisor.validate(event.sender, data.generation)
      intents.acknowledge(id, data.generation, data.id)
    },
    [Commands.RecoverCurrentRenderer]: (
      event: Electron.IpcMainInvokeEvent,
      raw: unknown
    ) => {
      const { generation } = rendererRecoveryRequestSchema.parse(raw)
      return supervisor.recoverManually(
        supervisor.validate(event.sender, generation)
      )
    },
    [Commands.OpenRendererDiagnostics]: (
      event: Electron.IpcMainInvokeEvent,
      raw: unknown
    ) => {
      const { generation } = rendererRecoveryRequestSchema.parse(raw)
      supervisor.validate(event.sender, generation)
      return shell.openPath(deps.logDirectory)
    },
  }
  for (const [channel, handler] of Object.entries(handlers))
    registerTrustedIpcHandler(channel, handler)
  const suspend = () => supervisor.setSuspended(true)
  const resume = () => supervisor.setSuspended(false)
  const lock = () => supervisor.setLocked(true)
  const unlock = () => supervisor.setLocked(false)
  const childGone = (_event: unknown, details: Electron.Details) => {
    if (details.type === 'GPU') supervisor.gpuExited()
  }
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  app.on('child-process-gone', childGone)
  supervisor.start()
  return {
    supervisor,
    intents,
    submissions,
    recoverFocused: () => {
      const id =
        (['onboarding', 'add-task', 'main'] as const).find((id) =>
          deps.windows().get(id)?.isFocused()
        ) ?? 'main'
      if (!deps.windows().get(id)) {
        deps.windows().show(id)
        return
      }
      supervisor.recoverManually(id)
    },
    dispose: () => {
      supervisor.dispose()
      pendingPrompts.clear()
      for (const channel of Object.keys(handlers))
        ipcMain.removeHandler(channel)
      powerMonitor.off('suspend', suspend)
      powerMonitor.off('resume', resume)
      powerMonitor.off('lock-screen', lock)
      powerMonitor.off('unlock-screen', unlock)
      app.off('child-process-gone', childGone)
      void diagnostics.drain()
    },
  }
}
