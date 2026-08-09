import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RegistryStore } from '@core/bridge/trusted-extension-registry'

export class FileRegistryStoreAdapter implements RegistryStore {
  constructor(private filePath: string) {}

  async read(): Promise<string | null> {
    try {
      return await readFile(this.filePath, 'utf-8')
    } catch {
      return null
    }
  }

  async write(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, content, 'utf-8')
  }
}
