import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

function receiptPath(pluginsDir: string, archiveSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256))
    throw new Error('Invalid archive digest')
  // Outside every plugin directory and extraction root. A package cannot
  // supply its own receipt. Receipts survive uninstall for the same bytes.
  return path.join(pluginsDir, '_security-admissions', archiveSha256)
}

export async function hasSecurityAdmission(
  pluginsDir: string,
  archiveSha256: string | undefined
): Promise<boolean> {
  if (!archiveSha256) return false
  try {
    return (
      (await readFile(receiptPath(pluginsDir, archiveSha256), 'utf8')) ===
      'approved\n'
    )
  } catch {
    return false
  }
}

export async function recordSecurityAdmission(
  pluginsDir: string,
  archiveSha256: string
): Promise<void> {
  const file = receiptPath(pluginsDir, archiveSha256)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, 'approved\n', { mode: 0o600 })
}
