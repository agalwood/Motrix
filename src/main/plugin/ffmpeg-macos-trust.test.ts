// @vitest-environment node
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { FfmpegTarget } from '@shared/schemas/ffmpeg-release'
import { describe, expect, it, vi } from 'vitest'
import type { RunCommand } from '../cli/command-runner'
import {
  verifyMacFfmpegBinaryTrust,
  verifyMacFfmpegTrust,
} from './ffmpeg-macos-trust'

const identity = vi.hoisted(() => {
  const bytes = Buffer.from('ephemeral certificate fixture')
  return { bytes }
})
vi.mock('@shared/config/ffmpeg-macos-certificate.json', () => ({
  default: {
    certificateSha256: createHash('sha256')
      .update(identity.bytes)
      .digest('hex'),
  },
}))
function target(): FfmpegTarget {
  return {
    platform: 'darwin',
    signing: {
      identity: {
        teamId: 'TESTTEAM01',
        subject: 'Developer ID Application: Test (TESTTEAM01)',
        certificateSha256: createHash('sha256')
          .update(identity.bytes)
          .digest('hex'),
      },
      binaries: {
        ffmpeg: { cdHash: 'a'.repeat(40), timestamp: '2026-09-30T12:00:00Z' },
        ffprobe: { cdHash: 'a'.repeat(40), timestamp: '2026-09-30T12:00:00Z' },
      },
    },
  } as FfmpegTarget
}
function runner(violation?: string, timestamp = 'Sep 30, 2026 at 12:00:00 PM') {
  return vi.fn<RunCommand>(async (command, args) => {
    if (violation === 'os-failed')
      return { code: 1, stdout: '', stderr: 'rejected' }
    if (violation === 'truncated')
      return { code: 0, stdout: '', stderr: '', truncated: true }
    if (
      args.includes('--verify') &&
      ['notary', 'expired', 'apple-unavailable'].includes(violation ?? '')
    )
      return {
        code: 1,
        stdout: '',
        stderr: 'explicit trust requirement failed',
      }
    if (violation === 'timeout')
      return { code: null, stdout: '', stderr: '', timedOut: true }
    if (args.some((arg) => arg.startsWith('--extract-certificates='))) {
      const prefix = args
        .find((arg) => arg.startsWith('--extract-certificates='))!
        .split('=')[1]
      await writeFile(
        `${prefix}0`,
        violation === 'certificate' ? Buffer.from('wrong cert') : identity.bytes
      )
    }
    if (args.includes('--verbose=4') && command.endsWith('codesign')) {
      const name = args.at(-1)!.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'
      let stderr = `Identifier=net.agalwood.motrix.${name}\nTeamIdentifier=TESTTEAM01\nCDHash=${'a'.repeat(40)}\nTimestamp=${timestamp}\nAuthority=Developer ID Application: Test (TESTTEAM01)\nCodeDirectory v=20500 size=42 flags=0x10000(runtime)\n`
      if (violation === 'team')
        stderr = stderr.replace(
          'TeamIdentifier=TESTTEAM01',
          'TeamIdentifier=WRONGTEAM1'
        )
      if (violation === 'cdhash')
        stderr = stderr.replace('CDHash=aa', 'CDHash=bb')
      if (violation === 'timestamp')
        stderr = stderr.replace(
          'Timestamp=Sep 30, 2026 at 12:00:00 PM',
          'Timestamp=none'
        )
      if (violation === 'nbsp') stderr = stderr.replace('00 PM', '00\u00a0PM')
      if (violation === 'narrow-nbsp')
        stderr = stderr.replace('00 PM', '00\u202fPM')
      if (violation === 'hardened')
        stderr = stderr.replace('flags=0x10000(runtime)', 'flags=0x0(none)')
      if (violation === 'ambiguous') stderr += 'TeamIdentifier=TESTTEAM01\n'
      return { code: 0, stdout: '', stderr }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}
const url =
  'https://github.com/motrixapp/ffmpeg-static/releases/download/v9.0.2-motrix.8/ffmpeg-9.0.2-motrix.8-darwin-arm64.zip'
describe('managed macOS FFmpeg system trust', () => {
  it.each([
    ['Oct 1, 2026 at 16:18:51', '2026-10-01T16:18:51Z'],
    ['1 Oct 2026 at 16:18:51', '2026-10-01T16:18:51Z'],
    ['Oct 1, 2026 at 4:18:51 PM', '2026-10-01T16:18:51Z'],
    ['1 Oct 2026 at 4:18:51 PM', '2026-10-01T16:18:51Z'],
    ['1 Oct 2026 at 4:18:51 AM', '2026-10-01T04:18:51Z'],
    ['Oct 1, 2026 at 12:18:51 AM', '2026-10-01T00:18:51Z'],
    ['1 Oct 2026 at 12:18:51 AM', '2026-10-01T00:18:51Z'],
    ['1 Oct 2026 at 12:18:51 PM', '2026-10-01T12:18:51Z'],
    ['1 Oct 2026 at 00:18:51', '2026-10-01T00:18:51Z'],
    ['1\u00a0Oct\u202f2026 at 4:18:51\u202fPM', '2026-10-01T16:18:51Z'],
    ['29 Feb 2024 at 23:59:59', '2024-02-29T23:59:59Z'],
  ])(
    'matches the secure date %s to the authenticated UTC timestamp',
    async (display, timestamp) => {
      const release = target()
      for (const name of ['ffmpeg', 'ffprobe'] as const)
        release.signing!.binaries[name].timestamp = timestamp
      await expect(
        verifyMacFfmpegTrust(
          '/fixture',
          release,
          url,
          runner(undefined, display)
        )
      ).resolves.toBeUndefined()
    }
  )
  it.each([
    '30 Sep 2026 at 12:00:01 PM',
    '30 Sep 2026 at 12:00:00 AM',
    '30 Sep 2026 at 00:00:00 PM',
    '30 Sep 2026 at 13:00:00 PM',
    '30 Sep 2026 at 24:00:00',
    '30 Sep 2026 at 12:60:00',
    '30 Sep 2026 at 12:00:60',
    '31 Sep 2026 at 12:00:00',
    '29 Feb 2026 at 12:00:00',
    '0 Sep 2026 at 12:00:00',
    '30 Xxx 2026 at 12:00:00',
    '30/09/2026 12:00:00',
    '30 Sep 2026 at 12:00:00 UTC',
    '30 Sep 2026\nat 12:00:00',
    'Sep 30, 2026 at 12:00:00 PM\nTimestamp=30 Sep 2026 at 12:00:00',
  ])(
    'rejects invalid, ambiguous or mismatched timestamps: %s',
    async (display) => {
      await expect(
        verifyMacFfmpegTrust(
          '/fixture',
          target(),
          url,
          runner(undefined, display)
        )
      ).rejects.toThrow()
    }
  )
  it('checks a legacy CLI binary without changing quarantine or requiring a sibling ffprobe', async () => {
    const run = runner(undefined, '30 Sep 2026 at 12:00:00')
    await verifyMacFfmpegBinaryTrust('/legacy/ffmpeg', 'ffmpeg', target(), run)
    expect(
      run.mock.calls.every(
        ([command, args]) =>
          command === '/usr/bin/codesign' && args.at(-1) === '/legacy/ffmpeg'
      )
    ).toBe(true)
    expect(
      run.mock.calls.some(([, args]) => args.includes('--check-notarization'))
    ).toBe(true)
  })
  it('checks both CLI binaries with Apple anchoring, online notarization, a pinned leaf certificate and secure UTC timestamps', async () => {
    const run = runner()
    await verifyMacFfmpegTrust('/fixture', target(), url, run)
    const calls = run.mock.calls
    expect(calls.filter(([command]) => command.endsWith('spctl'))).toHaveLength(
      0
    )
    expect(calls.filter(([command]) => command.endsWith('xattr'))).toHaveLength(
      2
    )
    expect(calls.filter(([, args]) => args.includes('--verify'))).toHaveLength(
      2
    )
    for (const [, args] of calls.filter(([, args]) =>
      args.includes('--verify')
    )) {
      expect(args[args.indexOf('-R') + 1]).toBe(
        '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and notarized'
      )
      expect(args).toContain('--check-notarization')
    }
    expect(calls.every(([, , options]) => options?.env?.TZ === 'UTC')).toBe(
      true
    )
    expect(
      calls.some(([, args]) => args.includes('-d') || args.includes('-c'))
    ).toBe(false)
  })
  it.each(['nbsp', 'narrow-nbsp'])(
    'accepts the macOS %s AM/PM separator without relaxing timestamp evidence',
    async (separator) => {
      await expect(
        verifyMacFfmpegTrust('/fixture', target(), url, runner(separator))
      ).resolves.toBeUndefined()
    }
  )
  it.each([
    'certificate',
    'team',
    'cdhash',
    'timestamp',
    'hardened',
    'ambiguous',
    'notary',
    'expired',
    'apple-unavailable',
    'timeout',
    'os-failed',
    'truncated',
  ])('fails closed on %s without executing the payload', async (violation) => {
    const run = runner(violation)
    await expect(
      verifyMacFfmpegTrust('/fixture', target(), url, run)
    ).rejects.toThrow()
    expect(
      run.mock.calls.every(([command]) =>
        ['/usr/bin/xattr', '/usr/bin/codesign'].includes(command)
      )
    ).toBe(true)
  })
})
