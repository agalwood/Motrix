import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readEngineSource, sha256Hex } from './engine-source.mjs'
import {
  ENGINE_DIGEST_ALGORITHM,
  nativeEngineDigest,
} from './native-engine-digest.mjs'

export async function verifyEngineArtifact(
  binaryPath,
  receiptPath,
  licensePath,
  target,
  root
) {
  const { lock, sourceDigest } = await readEngineSource(root)
  const asset = lock.assets[`${target.platform}-${target.arch}`]
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const binarySha256 = sha256Hex(await readFile(binaryPath))
  const contentMatches =
    receipt.binarySha256 === binarySha256 ||
    (receipt.digestAlgorithm === ENGINE_DIGEST_ALGORITHM &&
      /^[a-f0-9]{64}$/.test(receipt.nativePayloadSha256 ?? '') &&
      (await nativeEngineDigest(binaryPath, target.platform)) ===
        receipt.nativePayloadSha256)
  if (
    !asset ||
    path.basename(binaryPath) !== asset.bin ||
    receipt.version !== lock.version ||
    receipt.sourceDigest !== sourceDigest ||
    receipt.target !==
      (target.distribution === 'flatpak'
        ? asset.flatpakRustTarget
        : asset.rustTarget) ||
    receipt.profile !== 'release' ||
    !contentMatches ||
    receipt.licenseSha256 !== sha256Hex(await readFile(licensePath))
  ) {
    throw new Error(
      'taiji artifact does not match the locked source build and target'
    )
  }
  return { version: lock.version, sha256: binarySha256 }
}
