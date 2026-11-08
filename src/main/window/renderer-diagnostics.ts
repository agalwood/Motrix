import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RendererIncident } from './renderer-supervisor'

/** Fixed, bounded diagnostics. Never receives URLs, arguments, paths or stacks. */
export class RendererDiagnostics {
  private recent: RendererIncident[] = []
  private pending: string[] = []
  private writing: Promise<void> | undefined
  constructor(readonly directory: string) {}
  record(incident: RendererIncident): void {
    this.recent.push(incident)
    if (this.recent.length > 100) this.recent.shift()
    this.pending.push(
      `${JSON.stringify({ at: new Date().toISOString(), ...incident })}\n`
    )
    if (this.pending.length > 100) this.pending.shift()
    this.flush()
  }
  snapshot(): readonly RendererIncident[] {
    return this.recent.map((item) => ({ ...item }))
  }
  async drain(): Promise<void> {
    await this.writing
  }
  private flush(): void {
    if (this.writing) return
    this.writing = this.write()
      .catch(() => {
        this.pending = []
      })
      .finally(() => {
        this.writing = undefined
        if (this.pending.length) this.flush()
      })
  }
  private async write(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, 'renderer-health.jsonl')
    while (this.pending.length) {
      const line = this.pending.shift()
      if (!line) continue
      const size = await stat(file).then(
        (value) => value.size,
        () => 0
      )
      if (size + Buffer.byteLength(line) > 2 * 1024 * 1024) {
        await rm(`${file}.2`, { force: true })
        await rename(`${file}.1`, `${file}.2`).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          }
        )
        await rename(file, `${file}.1`)
      }
      await appendFile(file, line, { mode: 0o600 })
    }
  }
}
