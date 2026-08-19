import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

/**
 * Writes a small JSON file describing the running WebSocket bridge endpoint
 * so the Native Messaging host binary can discover Motrix's WS port and a
 * same-machine CLI/agent can discover the port + the machine-owner local
 * token + the current server generation.
 *
 * The file contains `{ port, pid, writtenAt, localToken, generation }` and
 * lives at a known location (e.g.
 * `~/Library/Application Support/Motrix/bridge/endpoint.json`). The bridge
 * server writes it on start and clears it on stop.
 *
 * `localToken` is a Bearer secret for the unary `POST /mdxp` transport, so
 * the file is written atomically (temp file + fsync + rename — a crash
 * mid-write leaves the previous endpoint.json intact, never a truncated or
 * interleaved one) at owner-only (`0600`) permissions, and never logged.
 * This file's 0600 ownership is the attestation root the native host derives
 * its ticket-MAC key from (spec §9.1), so a reader must never observe a
 * partial write.
 */
export class EndpointFileWriter {
  constructor(private readonly filePath: string) {}

  async write(
    port: number,
    localToken: string,
    generation: string
  ): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const content = JSON.stringify({
      port,
      pid: process.pid,
      writtenAt: Date.now(),
      localToken,
      generation,
    })
    // The atomic write's `mode` only applies when CREATING the file; an
    // existing endpoint.json (e.g. after an unclean shutdown) keeps its old
    // perms, so chmod unconditionally to guarantee the token is never
    // group/other-readable.
    await writeFileAtomic(this.filePath, content, { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
