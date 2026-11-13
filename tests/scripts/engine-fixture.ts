import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
// @ts-expect-error JavaScript build policy
import { readEngineSource, sha256Hex } from '../../scripts/engine-source.mjs'

/** A fake executable with the real source-policy receipt; never runs the fixture. */
export async function writeEngineReceipt(
  binary: string,
  platform: string,
  arch: string,
  copyPolicyTo?: string
) {
  const { lock, sourceDigest } = await readEngineSource()
  const directory = path.dirname(binary)
  const licenses = 'fixture license notices'
  await writeFile(path.join(directory, 'taiji-licenses.txt'), licenses)
  await writeFile(
    path.join(directory, 'taiji-build.json'),
    JSON.stringify({
      version: lock.version,
      sourceDigest,
      profile: 'release',
      target: lock.assets[`${platform}-${arch}`].rustTarget,
      binarySha256: sha256Hex(await readFile(binary)),
      licenseSha256: sha256Hex(licenses),
    })
  )
  if (copyPolicyTo) {
    await mkdir(path.join(copyPolicyTo, 'scripts'), { recursive: true })
    for (const name of ['engine.lock.json', 'taiji-source.lock.json'])
      await copyFile(
        path.resolve('scripts', name),
        path.join(copyPolicyTo, 'scripts', name)
      )
  }
}
