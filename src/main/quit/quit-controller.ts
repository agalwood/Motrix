export type QuitPhase = 'idle' | 'confirming' | 'shutting-down'

export interface QuitConfirmResult {
  confirmed: boolean
  dontAskAgain: boolean
}

export interface QuitControllerDeps {
  getWarnBeforeQuit(): boolean
  getActiveCount(): number
  confirm(activeCount: number): Promise<QuitConfirmResult>
  persistDisableWarn(): Promise<void>
  beginShutdown(): void
}

/**
 * Owns all quit policy. Electron-free so it is unit-testable with stubs.
 * Tri-state guards the re-entrant `before-quit` flow:
 *   idle -> confirming -> (idle | shutting-down)
 *   idle -> shutting-down  (no-warn / force / session-end / nothing active)
 * `shutting-down` is terminal; beginShutdown() ends in app.quit() which
 * re-fires before-quit, and the index.ts guard relies on phase being terminal.
 */
export class QuitController {
  private _phase: QuitPhase = 'idle'
  private forceQuit = false
  private sessionEnding = false

  constructor(private deps: QuitControllerDeps) {}

  get phase(): QuitPhase {
    return this._phase
  }

  /** Programmatic quitters (auto-update install) call this to skip the dialog. */
  markForceQuit(): void {
    this.forceQuit = true
  }

  /** OS logout/shutdown sets this so the modal never blocks session end. */
  markSessionEnding(): void {
    this.sessionEnding = true
  }

  /** Forced exits bypass dialogs and start cleanup immediately. */
  requestForcedQuit(): void {
    this.forceQuit = true
    this.shutdown()
  }

  requestQuit(): void {
    if (this._phase === 'shutting-down') return
    if (
      this.forceQuit ||
      this.sessionEnding ||
      !this.deps.getWarnBeforeQuit()
    ) {
      this.shutdown()
      return
    }
    const count = this.deps.getActiveCount() // read ONCE
    if (count === 0) {
      this.shutdown()
      return
    }
    this._phase = 'confirming'
    this.deps
      .confirm(count)
      .then((result) => {
        if (this._phase === 'shutting-down') return
        if (!result.confirmed) {
          this._phase = 'idle' // cancel: touch nothing
          return
        }
        const persisted = result.dontAskAgain
          ? this.deps.persistDisableWarn()
          : Promise.resolve()
        return persisted.then(() => this.shutdown())
      })
      .catch(() => {
        // fail-open: a quit handler must never wedge the app unquittable
        this.shutdown()
      })
  }

  private shutdown(): void {
    if (this._phase === 'shutting-down') return
    this._phase = 'shutting-down'
    this.deps.beginShutdown()
  }
}
