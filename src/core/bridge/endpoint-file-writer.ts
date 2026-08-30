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
 * interleaved one) at owner-only (`0600`) permissions on POSIX, and never
 * logged. This file's ownership is the attestation root the native host
 * derives its ticket-MAC key from (spec §9.1), so a reader must never observe
 * a partial write. On Windows the `0600` is not achievable from here — see
 * the note at the `chmod` below — and the host's own check is what decides
 * whether the file can root an attestation there.
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
    //
    // POSIX only. Node's `chmod` on Windows toggles the read-only attribute
    // and does not touch the ACL, so there the file simply inherits the
    // parent directory's DACL. That is why the native host's Windows
    // owner-only check admits SYSTEM and Administrators: nothing here can
    // produce a DACL narrower than what `%APPDATA%` grants, and a reader
    // check stricter than the writer can satisfy would reject every healthy
    // install.
    await writeFileAtomic(this.filePath, content, { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
