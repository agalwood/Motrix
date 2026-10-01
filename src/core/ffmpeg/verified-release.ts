import { createHash, createPublicKey, verify } from 'node:crypto'
import macosCertificate from '@shared/config/ffmpeg-macos-certificate.json'
import releaseKey from '@shared/config/ffmpeg-release-key.json'
import {
  FFMPEG_MINIMUM_RELEASE,
  FFMPEG_SIGNATURE_DOMAIN,
  type FfmpegPlatform,
  ffmpegManifestSchema,
  ffmpegReleaseVersionSchema,
  ffmpegSignatureSchema,
  ffmpegTargetSchema,
} from '@shared/schemas/ffmpeg-release'

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function compareFfmpegReleases(left: string, right: string): number {
  const parts = (value: string) =>
    ffmpegReleaseVersionSchema
      .parse(value)
      .split(/\.|-motrix\./)
      .map(Number)
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** Verify exact bytes BEFORE parsing the manifest; download never supplies a key. */
export function verifyFfmpegRelease(
  raw: Buffer,
  envelope: Buffer,
  arch: 'x64' | 'arm64',
  expectedTag?: string,
  platform: FfmpegPlatform = 'win32'
) {
  if (raw.length === 0 || raw.length > 1024 * 1024 || envelope.length > 4096) {
    throw new Error('FFmpeg manifest exceeds limits')
  }
  const signature = ffmpegSignatureSchema.parse(
    JSON.parse(envelope.toString('utf8'))
  )
  const key = createPublicKey(releaseKey.publicKey)
  const derivedId = `sha256:${sha256(key.export({ format: 'der', type: 'spki' }))}`
  const decoded = Buffer.from(signature.signature, 'base64')
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    derivedId !== releaseKey.keyId ||
    signature.keyId !== releaseKey.keyId ||
    decoded.length !== 64 ||
    decoded.toString('base64') !== signature.signature ||
    !verify(
      null,
      Buffer.concat([Buffer.from(FFMPEG_SIGNATURE_DOMAIN), raw]),
      key,
      decoded
    )
  ) {
    throw new Error('Untrusted FFmpeg release signature')
  }
  const manifest = ffmpegManifestSchema.parse(JSON.parse(raw.toString('utf8')))
  const allTargets = manifest.targets.map((item) =>
    ffmpegTargetSchema.parse(item)
  )
  if (
    (expectedTag !== undefined && manifest.releaseTag !== expectedTag) ||
    compareFfmpegReleases(manifest.releaseVersion, FFMPEG_MINIMUM_RELEASE) < 0
  ) {
    throw new Error('FFmpeg release identity or minimum version mismatch')
  }
  const target = ffmpegTargetSchema.parse(
    allTargets.find((item) => item.target === `${platform}-${arch}`)
  )
  if (target.releaseVersion !== manifest.releaseVersion) {
    throw new Error('FFmpeg target version mismatch')
  }
  if (
    target.platform === 'darwin' &&
    target.signing?.identity.certificateSha256 !==
      macosCertificate.certificateSha256
  ) {
    throw new Error('FFmpeg Developer ID certificate identity mismatch')
  }
  if (
    allTargets.some((item) => item.releaseVersion !== manifest.releaseVersion)
  )
    throw new Error('FFmpeg platform set version mismatch')
  return { manifest, target, allTargets, manifestHash: sha256(raw) }
}

/** Inspect architecture without executing the downloaded payload. */
export function verifyFfmpegBinary(
  bytes: Buffer,
  platform: FfmpegPlatform,
  arch: 'x64' | 'arm64'
) {
  if (platform === 'win32') return verifyWindowsPe(bytes, arch)
  if (platform === 'darwin') {
    if (
      bytes.length < 32 ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007) ||
      bytes.readUInt32LE(12) !== 2
    )
      throw new Error('Invalid FFmpeg Mach-O architecture')
    return
  }
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)
  )
    throw new Error('Invalid FFmpeg ELF architecture')
}

export function verifyWindowsPe(bytes: Buffer, arch: 'x64' | 'arm64') {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Invalid Windows FFmpeg executable')
  }
  const offset = bytes.readUInt32LE(60)
  if (
    offset > 64 * 1024 ||
    offset + 176 > bytes.length ||
    bytes.readUInt32LE(offset) !== 0x00004550 ||
    bytes.readUInt16LE(offset + 4) !== (arch === 'arm64' ? 0xaa64 : 0x8664) ||
    bytes.readUInt16LE(offset + 24) !== 0x20b ||
    bytes.readUInt16LE(offset + 20) < 152 ||
    bytes.readUInt32LE(offset + 24 + 112 + 4 * 8) !== 0 ||
    bytes.readUInt32LE(offset + 24 + 112 + 4 * 8 + 4) !== 0
  ) {
    throw new Error('Windows FFmpeg architecture or unsigned policy mismatch')
  }
}
