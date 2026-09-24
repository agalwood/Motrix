import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'

// Builtins-only worker source is embedded so both packaged hosts can run it
// without another bundled entrypoint. The parent owns and closes the fd.
const HASH_WORKER = `
const { parentPort, workerData: fd } = require('node:worker_threads')
const { readSync } = require('node:fs')
const { createHash } = require('node:crypto')
const hash = createHash('sha256')
const buffer = Buffer.allocUnsafe(1024 * 1024)
let offset = 0
for (;;) {
  const length = readSync(fd, buffer, 0, buffer.length, offset)
  if (length === 0) break
  hash.update(buffer.subarray(0, length))
  offset += length
}
parentPort.postMessage(hash.digest('hex'))
parentPort.close()
`

export async function hashOpenedFile(
  handle: FileHandle,
  size: bigint
): Promise<string> {
  if (size < 16n * 1024n * 1024n) {
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      start: 0,
    })) {
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
  }
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(HASH_WORKER, {
      eval: true,
      workerData: handle.fd,
    })
    let digest: string | undefined
    worker.once('message', (value: string) => {
      digest = value
    })
    worker.once('error', reject)
    // Wait for exit before allowing the owner to close/reuse the descriptor.
    worker.once('exit', (code) => {
      if (code === 0 && digest) resolve(digest)
      else
        reject(
          new Error(`artifact hash worker exited without a digest: ${code}`)
        )
    })
  })
}
