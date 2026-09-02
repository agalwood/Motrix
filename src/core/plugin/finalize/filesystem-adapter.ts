import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import path from 'node:path'

export type FinalizeFsErrorCode =
  | 'unsupported'
  | 'target_exists'
  | 'not_found'
  | 'invalid_path'
  | 'invalid_handle'
  | 'permission_denied'
  | 'cross_device'
  | 'symlink_rejected'
  | 'io_error'

export class FinalizeFsError extends Error {
  constructor(
    readonly code: FinalizeFsErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'FinalizeFsError'
  }
}

export interface FinalizeFsCapabilities {
  platform: string
  renameNoReplace: boolean
  heldRoots: boolean
  directorySync: boolean
  heldArtifacts: boolean
}

interface WireResponse {
  request_id?: number
  status: 'ok' | 'error'
  handle?: number
  code?: FinalizeFsErrorCode
  message?: string
  platform?: string
  rename_no_replace?: boolean
  held_roots?: boolean
  directory_sync?: boolean
  held_artifacts?: boolean
}

interface PendingRequest {
  resolve: (value: WireResponse) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export interface NativeFinalizeFilesystemAdapterOptions {
  requestTimeoutMs?: number
}

export interface FinalizeRootHandle {
  readonly id: number
}

export interface FinalizeArtifactHandle {
  readonly id: number
}

export interface FinalizeFilesystemAdapter {
  capabilities(): Promise<FinalizeFsCapabilities>
  openRoot(rootPath: string): Promise<FinalizeRootHandle>
  openArtifact(
    root: FinalizeRootHandle,
    relativePath: string
  ): Promise<FinalizeArtifactHandle>
  renameOpenedNoReplace(
    artifact: FinalizeArtifactHandle,
    targetRoot: FinalizeRootHandle,
    targetRelative: string
  ): Promise<void>
  copyOpened(
    artifact: FinalizeArtifactHandle,
    targetRoot: FinalizeRootHandle,
    targetRelative: string
  ): Promise<void>
  renameNoReplace(
    sourceRoot: FinalizeRootHandle,
    sourceRelative: string,
    targetRoot: FinalizeRootHandle,
    targetRelative: string
  ): Promise<void>
  removeOpened(
    artifact: FinalizeArtifactHandle,
    quarantineRelative: string,
    resumeIsolated: boolean
  ): Promise<void>
  syncRoot(root: FinalizeRootHandle): Promise<void>
  close(root: FinalizeRootHandle | FinalizeArtifactHandle): Promise<void>
  dispose(): Promise<void>
}

export class NativeFinalizeFilesystemAdapter
  implements FinalizeFilesystemAdapter
{
  private readonly child: ChildProcessWithoutNullStreams
  private nextRequestId = 1
  private incoming = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private readonly requestTimeoutMs: number
  private deadError: Error | null = null

  constructor(
    binaryPath: string,
    options: NativeFinalizeFilesystemAdapterOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    )
      throw new Error('finalize sidecar request timeout must be positive')
    this.child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    this.child.stderr.resume()
    this.child.stdin.once('error', (error) => this.markDead(error))
    this.child.once('error', (error) => this.markDead(error))
    this.child.once('exit', (code) =>
      this.markDead(new Error(`finalize filesystem sidecar exited: ${code}`))
    )
  }

  async capabilities(): Promise<FinalizeFsCapabilities> {
    const response = await this.request({ op: 'capabilities' }, false)
    return {
      platform: response.platform ?? 'unknown',
      renameNoReplace: response.rename_no_replace === true,
      heldRoots: response.held_roots === true,
      directorySync: response.directory_sync === true,
      heldArtifacts: response.held_artifacts === true,
    }
  }

  async openArtifact(
    root: FinalizeRootHandle,
    relativePath: string
  ): Promise<FinalizeArtifactHandle> {
    const response = await this.request({
      op: 'open_artifact',
      root: root.id,
      relative: relativePath,
    })
    if (response.handle === undefined) {
      throw new Error('sidecar omitted artifact handle')
    }
    return Object.freeze({ id: response.handle })
  }

  async renameOpenedNoReplace(
    artifact: FinalizeArtifactHandle,
    targetRoot: FinalizeRootHandle,
    targetRelative: string
  ): Promise<void> {
    await this.request({
      op: 'rename_opened_no_replace',
      artifact: artifact.id,
      target_root: targetRoot.id,
      target_relative: targetRelative,
    })
  }

  async copyOpened(
    artifact: FinalizeArtifactHandle,
    targetRoot: FinalizeRootHandle,
    targetRelative: string
  ): Promise<void> {
    await this.request({
      op: 'copy_opened',
      artifact: artifact.id,
      target_root: targetRoot.id,
      target_relative: targetRelative,
    })
  }

  async openRoot(rootPath: string): Promise<FinalizeRootHandle> {
    if (!path.isAbsolute(rootPath)) {
      throw new FinalizeFsError('invalid_path', 'root path must be absolute')
    }
    const response = await this.request({ op: 'open_root', path: rootPath })
    if (response.handle === undefined)
      throw new Error('sidecar omitted root handle')
    return Object.freeze({ id: response.handle })
  }

  async renameNoReplace(
    sourceRoot: FinalizeRootHandle,
    sourceRelative: string,
    targetRoot: FinalizeRootHandle,
    targetRelative: string
  ): Promise<void> {
    await this.request({
      op: 'rename_no_replace',
      source_root: sourceRoot.id,
      source_relative: sourceRelative,
      target_root: targetRoot.id,
      target_relative: targetRelative,
    })
  }

  async removeOpened(
    artifact: FinalizeArtifactHandle,
    quarantineRelative: string,
    resumeIsolated: boolean
  ): Promise<void> {
    await this.request({
      op: 'remove_opened',
      artifact: artifact.id,
      quarantine_relative: quarantineRelative,
      resume_isolated: resumeIsolated,
    })
  }

  async syncRoot(root: FinalizeRootHandle): Promise<void> {
    await this.request({ op: 'sync_root', root: root.id })
  }

  async close(
    root: FinalizeRootHandle | FinalizeArtifactHandle
  ): Promise<void> {
    await this.request({ op: 'close', handle: root.id })
  }

  async dispose(): Promise<void> {
    if (this.deadError) {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill()
      return
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill()
        resolve()
      }, this.requestTimeoutMs)
      timeout.unref()
      this.child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private async request(
    body: Record<string, unknown>,
    includeRequestId = true
  ): Promise<WireResponse> {
    if (this.deadError) throw this.deadError
    const requestId = this.nextRequestId++
    const payload = Buffer.from(
      JSON.stringify(
        includeRequestId ? { ...body, request_id: requestId } : body
      )
    )
    if (payload.length > 64 * 1024)
      throw new Error('finalize sidecar request too large')
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32LE(payload.length)
    payload.copy(frame, 4)
    const response = new Promise<WireResponse>((resolve, reject) => {
      const key = includeRequestId ? requestId : 0
      const timeout = setTimeout(() => {
        const error = new Error(
          `finalize filesystem sidecar request timed out after ${this.requestTimeoutMs}ms`
        )
        this.markDead(error)
        this.child.kill()
      }, this.requestTimeoutMs)
      timeout.unref()
      this.pending.set(key, { resolve, reject, timeout })
    })
    this.child.stdin.write(frame, (error) => {
      if (error) this.markDead(error)
    })
    const result = await response
    if (result.status === 'error') {
      throw new FinalizeFsError(
        result.code ?? 'io_error',
        result.message ?? 'finalize filesystem operation failed'
      )
    }
    return result
  }

  private receive(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk])
    while (this.incoming.length >= 4) {
      const length = this.incoming.readUInt32LE(0)
      if (length > 64 * 1024) {
        this.markDead(new Error('finalize sidecar response too large'))
        this.child.kill()
        return
      }
      if (this.incoming.length < length + 4) return
      const payload = this.incoming.subarray(4, length + 4)
      this.incoming = this.incoming.subarray(length + 4)
      let response: WireResponse
      try {
        response = JSON.parse(payload.toString('utf8')) as WireResponse
      } catch (error) {
        this.markDead(error as Error)
        this.child.kill()
        return
      }
      const key = response.request_id ?? 0
      const pending = this.pending.get(key)
      if (!pending) {
        if (response.request_id === undefined && this.pending.size > 0) {
          this.markDead(
            new FinalizeFsError(
              response.code ?? 'io_error',
              response.message ?? 'unattributed finalize sidecar response'
            )
          )
          this.child.kill()
          return
        }
        continue
      }
      this.pending.delete(key)
      clearTimeout(pending.timeout)
      pending.resolve(response)
    }
  }

  private markDead(error: Error): void {
    if (!this.deadError) this.deadError = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(this.deadError)
    }
    this.pending.clear()
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill()
  }
}
