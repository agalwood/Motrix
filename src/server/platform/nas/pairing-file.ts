import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

const MAX_BYTES = 4 * 1024 * 1024

export interface NasPairingStorage {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

export function nasPairingFile(file: string): NasPairingStorage {
  return {
    async read() {
      const handle = await open(file, 'r').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        }
      )
      if (!handle) return null
      try {
        const buffer = Buffer.alloc(MAX_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            length
          )
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > MAX_BYTES)
          throw new Error('NAS pairing document too large')
        return buffer.subarray(0, length).toString('utf8')
      } finally {
        await handle.close()
      }
    },
    async write(value) {
      if (Buffer.byteLength(value) > MAX_BYTES)
        throw new Error('NAS pairing document too large')
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await writeFileAtomic(file, value, { mode: 0o600 })
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(file), 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    },
  }
}
