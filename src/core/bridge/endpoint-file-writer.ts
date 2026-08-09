import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes a small JSON file describing the running WebSocket bridge endpoint
 * so the Native Messaging host binary can discover Motrix's WS port and a
 * same-machine CLI/agent can discover the port + the machine-owner local token.
 *
 * The file contains `{ port, pid, writtenAt, localToken }` and lives at a known
 * location (e.g. `~/Library/Application Support/Motrix/bridge/endpoint.json`).
 * The bridge server writes it on start and clears it on stop.
 *
 * `localToken` is a Bearer secret for the unary `POST /mdxp` transport, so the
 * file is written with owner-only (`0600`) permissions and never logged.
 */
export class EndpointFileWriter {
  constructor(private readonly filePath: string) {}

  async write(port: number, localToken: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const writtenAt = Date.now()
    const content = JSON.stringify({
      port,
      pid: process.pid,
      writtenAt,
      localToken,
    })
    // `mode` on writeFile only applies when CREATING the file; an existing
    // endpoint.json (e.g. after an unclean shutdown) keeps its old perms, so
    // chmod unconditionally to guarantee the token is never group/other-readable.
    await writeFile(this.filePath, content, { encoding: 'utf-8', mode: 0o600 })
    await chmod(this.filePath, 0o600)
    // `writtenAt` is diagnostic metadata only. The native host determines
    // liveness by probing the recorded loopback port and never reads or logs
    // `localToken`.
    console.log(
      `[bridge-debug] endpoint.json written port=${port} writtenAt=${writtenAt}`
    )
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
