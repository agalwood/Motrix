import { type NatManager, TokenBucket } from '@motrix/nat'
import { ErrorCode } from '@shared/errors'

export interface PrivacyDialog {
  dialogConfirm: (options: {
    title: string
    message: string
    detail: string
  }) => Promise<boolean>
}

export interface NatCommandResult<T = void> {
  ok: boolean
  error?: ErrorCode
  value?: T
}

export class NatCommandHandlers {
  private readonly buckets: {
    forceRemap: TokenBucket
    runDiagnostic: TokenBucket
    exportBundle: TokenBucket
    enableDisable: TokenBucket
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used by Task 57 privacy dialog
  private readonly dialog: PrivacyDialog

  constructor(
    private readonly manager: NatManager,
    dialog: PrivacyDialog,
    options: { now?: () => number } = {}
  ) {
    this.dialog = dialog
    const now = options.now
    this.buckets = {
      forceRemap: new TokenBucket({
        capacity: 1,
        refillPerSec: 1 / 30,
        now,
      }),
      runDiagnostic: new TokenBucket({
        capacity: 1,
        refillPerSec: 1 / 60,
        now,
      }),
      exportBundle: new TokenBucket({
        capacity: 1,
        refillPerSec: 1 / 300,
        now,
      }),
      enableDisable: new TokenBucket({
        capacity: 1,
        refillPerSec: 1 / 5,
        now,
      }),
    }
  }

  async enable(): Promise<NatCommandResult> {
    if (!this.buckets.enableDisable.tryAcquire()) {
      return { ok: false, error: ErrorCode.IpcRateLimited }
    }
    await this.manager.enable()
    return { ok: true }
  }

  async disable(): Promise<NatCommandResult> {
    if (!this.buckets.enableDisable.tryAcquire()) {
      return { ok: false, error: ErrorCode.IpcRateLimited }
    }
    await this.manager.disable()
    return { ok: true }
  }

  async forceRemap(): Promise<NatCommandResult> {
    if (!this.buckets.forceRemap.tryAcquire()) {
      return { ok: false, error: ErrorCode.IpcRateLimited }
    }
    await this.manager.forceRemap()
    return { ok: true }
  }

  async runDiagnostic(): Promise<NatCommandResult> {
    if (!this.buckets.runDiagnostic.tryAcquire()) {
      return { ok: false, error: ErrorCode.IpcRateLimited }
    }
    await this.manager.runDiagnostic()
    return { ok: true }
  }

  async exportBundle(): Promise<NatCommandResult<unknown>> {
    if (!this.buckets.exportBundle.tryAcquire()) {
      return { ok: false, error: ErrorCode.IpcRateLimited }
    }
    const bundle = await this.manager.exportBundle()
    return { ok: true, value: bundle }
  }
}
