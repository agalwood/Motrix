import { z } from 'zod'

export const FFMPEG_REPOSITORY = 'motrixapp/ffmpeg-static'
export const FFMPEG_SIGNATURE_DOMAIN = 'Motrix FFmpeg release manifest v1\n'
export const FFMPEG_MINIMUM_RELEASE = '9.0.2-motrix.8'
export const FFMPEG_WINDOWS_LICENSE =
  'GPL-2.0-or-later AND LGPL-2.1-or-later AND IJG AND ISC AND MIT AND BSD-1-Clause AND BSD-2-Clause AND BSD-3-Clause AND Zlib AND BSL-1.0 AND (Apache-2.0 WITH LLVM-exception) AND LicenseRef-MinGW-w64-runtime'
export const ffmpegReleaseVersionSchema = z
  .string()
  .max(64)
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}-motrix\.\d{1,6}$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const targets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
] as const
export const ffmpegPlatformSchema = z.enum(['darwin', 'linux', 'win32'])
export const ffmpegArchSchema = z.enum(['x64', 'arm64'])
const baseLicense = FFMPEG_WINDOWS_LICENSE.split(' AND (Apache-2.0')[0]
const licenses = {
  darwin: baseLicense,
  linux: `${baseLicense} AND 0BSD AND SunPro AND (GPL-3.0-or-later WITH GCC-exception-3.1)`,
  win32: FFMPEG_WINDOWS_LICENSE,
}
export const ffmpegMacSigningSchema = z
  .object({
    schemaVersion: z.literal(3),
    target: z.enum(['darwin-x64', 'darwin-arm64']),
    platform: z.literal('darwin'),
    kind: z.literal('apple-developer-id'),
    identity: z
      .object({
        teamId: z.string().regex(/^[A-Z0-9]{10}$/),
        subject: z.string().max(256).startsWith('Developer ID Application:'),
        certificateSha256: hash,
      })
      .strict(),
    binaries: z.record(
      z.enum(['ffmpeg', 'ffprobe']),
      z
        .object({
          sha256: hash,
          cdHash: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
          timestamp: z.iso.datetime(),
          hardenedRuntime: z.literal(true),
        })
        .strict()
    ),
    notarization: z
      .object({
        submissionId: z.uuid(),
        status: z.literal('Accepted'),
        submissionResultSha256: hash,
        developerLog: z
          .object({
            name: z.string().max(160),
            sha256: hash,
            size: z
              .number()
              .int()
              .positive()
              .max(8 * 1024 * 1024),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export const ffmpegSignatureSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal('Ed25519'),
    keyId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    signature: z.string().length(88),
  })
  .strict()

export const ffmpegManifestSchema = z
  .object({
    schemaVersion: z.literal(3),
    repository: z.literal(FFMPEG_REPOSITORY),
    windowsTrust: z.literal('motrix-ed25519'),
    formalRelease: z.literal(true),
    releaseVersion: ffmpegReleaseVersionSchema,
    releaseTag: z.string().max(80),
    releaseCommit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    controlCommit: z.string(),
    profile: z.literal('motrix-full-gpl'),
    targets: z
      .array(z.object({ target: z.enum(targets) }).passthrough())
      .length(6),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      value.releaseTag !== `v${value.releaseVersion}` ||
      value.releaseCommit !== value.controlCommit ||
      new Set(value.targets.map((item) => item.target)).size !== 6
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid release identity' })
    }
  })

export const ffmpegTargetSchema = z
  .object({
    schemaVersion: z.literal(2),
    releaseVersion: ffmpegReleaseVersionSchema,
    target: z.enum(targets),
    platform: ffmpegPlatformSchema,
    arch: ffmpegArchSchema,
    minimumOs: z
      .object({
        name: z.enum(['macos', 'linux', 'windows']),
        version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
      })
      .strict(),
    license: z.string().max(512),
    archive: z.string().max(120),
    archiveSha256: hash,
    archiveSize: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    binaryPath: z.enum(['ffmpeg', 'ffmpeg.exe']),
    binarySha256: hash,
    ffprobePath: z.enum(['ffprobe', 'ffprobe.exe']),
    ffprobeSha256: hash,
    buildInfoSha256: hash,
    configureSha256: hash,
    licensesSha256: hash,
    signing: ffmpegMacSigningSchema.nullable(),
    signingEvidenceSha256: hash.nullable(),
    licenseFiles: z
      .array(
        z
          .object({
            path: z
              .string()
              .regex(/^LICENSES\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/),
            sha256: hash,
          })
          .passthrough()
      )
      .min(1)
      .max(64),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      value.target !== `${value.platform}-${value.arch}` ||
      value.archive !==
        `ffmpeg-${value.releaseVersion}-${value.target}.${value.platform === 'linux' ? 'tar.gz' : 'zip'}` ||
      value.binaryPath !==
        (value.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') ||
      value.ffprobePath !==
        (value.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') ||
      value.license !== licenses[value.platform] ||
      value.minimumOs.name !==
        { darwin: 'macos', linux: 'linux', win32: 'windows' }[value.platform] ||
      (value.platform === 'win32' && value.minimumOs.version !== '10.0') ||
      (value.platform !== 'darwin' &&
        (value.signing !== null || value.signingEvidenceSha256 !== null)) ||
      (value.platform === 'darwin' &&
        (!value.signing ||
          !value.signingEvidenceSha256 ||
          value.signing.target !== value.target ||
          value.signing.binaries.ffmpeg.sha256 !== value.binarySha256 ||
          value.signing.binaries.ffprobe.sha256 !== value.ffprobeSha256 ||
          !value.signing.identity.subject.includes(
            `(${value.signing.identity.teamId})`
          ) ||
          value.signing.notarization.developerLog.name !==
            `ffmpeg-${value.releaseVersion}-${value.target}.notarization-log.json`)) ||
      new Set(value.licenseFiles.map((item) => item.path.toLowerCase()))
        .size !== value.licenseFiles.length ||
      value.licenseFiles.some(
        (item) =>
          item.path.endsWith('.') ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(
            item.path.slice('LICENSES/'.length)
          )
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid FFmpeg artifact identity',
      })
    }
  })

export const ffmpegInstallResultSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), releaseVersion: ffmpegReleaseVersionSchema })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum([
        'unavailable',
        'unsupported',
        'busy',
        'download',
        'verification',
        'install',
        'systemTrust',
      ]),
    })
    .strict(),
])
export type FfmpegTarget = z.infer<typeof ffmpegTargetSchema>
export type FfmpegPlatform = z.infer<typeof ffmpegPlatformSchema>
export type FfmpegArch = z.infer<typeof ffmpegArchSchema>
export const ffmpegInstallStatusSchema = z
  .object({
    phase: z.enum([
      'idle',
      'metadata',
      'downloading',
      'verifying',
      'extracting',
      'systemTrust',
      'installing',
      'installed',
      'failed',
    ]),
    bytesReceived: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
    percent: z.number().min(0).max(1).nullable(),
    releaseVersion: ffmpegReleaseVersionSchema.nullable(),
    directory: z.string().max(4096).nullable(),
    error: z
      .enum([
        'unavailable',
        'unsupported',
        'busy',
        'download',
        'verification',
        'install',
        'systemTrust',
      ])
      .nullable(),
  })
  .strict()
export type FfmpegInstallStatus = z.infer<typeof ffmpegInstallStatusSchema>

export const ffmpegLicenseInventorySchema = z
  .object({
    schemaVersion: z.literal(2),
    target: z.enum(targets),
    files: z
      .array(z.object({ path: z.string(), sha256: hash }).passthrough())
      .min(1)
      .max(64),
  })
  .strict()
