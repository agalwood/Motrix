import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '@core/ffmpeg/verified-release'
import { type RunCommand, runCommand } from '@core/process/command-runner'
import certificate from '@shared/config/ffmpeg-macos-certificate.json'
import type { FfmpegTarget } from '@shared/schemas/ffmpeg-release'

function parseSecureTimestamp(value: string): string {
  // codesign uses system date preferences even with LC_ALL=C. Normalize only
  // horizontal separators, then accept the explicit English date orders.
  const raw = value.replace(/[ \t\u00a0\u202f]+/g, ' ')
  const timestamp =
    /^(?:([A-Z][a-z]{2}) (\d{1,2}),|(\d{1,2}) ([A-Z][a-z]{2})) (\d{4}) at (\d{1,2}):(\d{2}):(\d{2})(?: (AM|PM))?$/.exec(
      raw
    )
  if (!timestamp) throw new Error('Missing secure FFmpeg timestamp')
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ].indexOf(timestamp[1] ?? timestamp[4])
  const day = Number(timestamp[2] ?? timestamp[3])
  const year = Number(timestamp[5])
  let hour = Number(timestamp[6])
  const minute = Number(timestamp[7])
  const second = Number(timestamp[8])
  if (timestamp[9]) {
    if (hour < 1 || hour > 12)
      throw new Error('Invalid secure FFmpeg timestamp')
    hour = (hour % 12) + (timestamp[9] === 'PM' ? 12 : 0)
  }
  const date = new Date(Date.UTC(year, month, day, hour, minute, second))
  if (
    month < 0 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    throw new Error('Invalid secure FFmpeg timestamp')
  return date.toISOString().replace('.000Z', 'Z')
}

/** Static OS checks only. Never execute an unverified payload or remove quarantine. */
export async function verifyMacFfmpegTrust(
  directory: string,
  target: FfmpegTarget,
  sourceUrl: string,
  run: RunCommand = runCommand
): Promise<void> {
  if (
    !sourceUrl.startsWith(
      'https://github.com/motrixapp/ffmpeg-static/releases/download/'
    )
  )
    throw new Error('Unexpected FFmpeg source')
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const binary = path.join(directory, name)
    // Network clients do not propagate Finder quarantine; mark this Internet download explicitly.
    await checked(run, '/usr/bin/xattr', [
      '-w',
      'com.apple.quarantine',
      `0081;${Math.floor(Date.now() / 1000).toString(16)};Motrix;${randomUUID()}`,
      binary,
    ])
    await verifyMacFfmpegBinaryTrust(binary, name, target, run)
  }
}

async function checked(run: RunCommand, command: string, args: string[]) {
  const result = await run(command, args, {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeoutMs: 30_000,
    maxBuffer: 64_000,
  })
  if (
    result.code !== 0 ||
    result.spawnError ||
    result.timedOut ||
    result.truncated
  )
    throw new Error('FFmpeg system trust check failed')
  return result
}

/** The caller authenticates the target and binary hash before these CLI checks. */
export async function verifyMacFfmpegBinaryTrust(
  binary: string,
  name: 'ffmpeg' | 'ffprobe',
  target: FfmpegTarget,
  run: RunCommand = runCommand
): Promise<void> {
  const signing = target.signing
  if (
    target.platform !== 'darwin' ||
    !signing ||
    signing.identity.certificateSha256 !== certificate.certificateSha256
  )
    throw new Error('Unexpected Developer ID identity')
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'motrix-ffmpeg-certificate-')
  )
  try {
    await checked(run, '/usr/bin/codesign', [
      '--verify',
      '--strict',
      '--check-notarization',
      '--verbose=2',
      '-R',
      '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and notarized',
      binary,
    ])
    const display = await checked(run, '/usr/bin/codesign', [
      '--display',
      '--verbose=4',
      binary,
    ])
    const text = `${display.stdout}\n${display.stderr}`
    const field = (label: string) => {
      const values = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${label}=`))
        .map((line) => line.slice(label.length + 1))
      if (values.length !== 1)
        throw new Error('Ambiguous FFmpeg signing identity')
      return values[0]
    }
    const record = signing.binaries[name]
    const canonicalTimestamp = parseSecureTimestamp(field('Timestamp'))
    const flags = /flags=0x([0-9a-f]+)\(/i.exec(text)
    // The Team ID is authenticated by the pinned manifest and compared only in memory.
    if (
      field('TeamIdentifier') !== signing.identity.teamId ||
      field('CDHash') !== record.cdHash ||
      canonicalTimestamp !== record.timestamp ||
      field('Identifier') !== `net.agalwood.motrix.${name}` ||
      !text.split(/\r?\n/).includes(`Authority=${signing.identity.subject}`) ||
      !flags ||
      (Number.parseInt(flags[1], 16) & 0x10000) === 0
    )
      throw new Error('FFmpeg signature evidence mismatch')
    const prefix = path.join(temporary, name)
    await checked(run, '/usr/bin/codesign', [
      '--display',
      `--extract-certificates=${prefix}`,
      binary,
    ])
    if (sha256(await readFile(`${prefix}0`)) !== certificate.certificateSha256)
      throw new Error('FFmpeg leaf certificate mismatch')
    // Apple prescribes the notarized requirement for standalone CLI tools;
    // spctl's application assessment rejects valid non-app executables.
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
