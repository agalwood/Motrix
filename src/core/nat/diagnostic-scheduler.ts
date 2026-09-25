import type { NatSettings } from '@shared/types/settings'

/** App-owned scheduling; the NAT library continues to own protocol operations. */
export class DiagnosticScheduler {
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private running?: Promise<void>
  private active = false
  private revision = 0
  private fingerprint = ''

  constructor(
    private readonly read: () => NatSettings,
    private readonly run: (signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  start() {
    this.active = true
    this.refresh()
  }
  refresh() {
    if (!this.active) return
    const settings = this.read()
    const key = JSON.stringify([
      settings.autoDiagnostic,
      settings.diagnosticIntervalSec,
      settings.natTypeDetectionEnabled,
      settings.stunServers,
      settings.portReachabilityCheckEnabled,
      settings.portCheckerEndpoints,
    ])
    if (key === this.fingerprint) return
    this.fingerprint = key
    this.revision++
    clearTimeout(this.timer)
    this.controller?.abort()
    this.schedule()
  }
  private enabled() {
    const settings = this.read()
    return (
      this.active &&
      settings.autoDiagnostic &&
      ((settings.natTypeDetectionEnabled && settings.stunServers.length > 0) ||
        (settings.portReachabilityCheckEnabled &&
          settings.portCheckerEndpoints.length > 0))
    )
  }
  private schedule() {
    if (!this.enabled()) return
    const revision = this.revision
    this.timer = setTimeout(() => {
      if (revision !== this.revision || !this.enabled()) return
      this.running = this.tick(revision)
    }, this.read().diagnosticIntervalSec * 1000)
    this.timer.unref?.()
  }
  private async tick(revision: number) {
    // A changed schedule waits for the prior (aborted) check before starting.
    const previous = this.running
    await previous
    if (revision !== this.revision || !this.enabled()) return
    const controller = new AbortController()
    this.controller = controller
    try {
      await this.run(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) this.onError(error)
    } finally {
      if (revision === this.revision && this.active) this.schedule()
    }
  }
  async stop() {
    this.active = false
    this.revision++
    this.fingerprint = ''
    clearTimeout(this.timer)
    this.controller?.abort()
    await this.running
  }
}
