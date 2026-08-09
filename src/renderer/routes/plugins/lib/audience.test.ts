import type { PluginListDTO } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import {
  abbreviatePluginName,
  avatarToneFor,
  computePluginAudience,
  isBroadHostAccess,
  permissionAudience,
  summarizeAccess,
  summarizeHealth,
  truncateOneLine,
} from './audience'

function fakeT(key: string, opts?: Record<string, unknown>): string {
  if (opts && 'name' in opts) return `${key}[${String(opts.name)}]`
  return key
}

function plugin(partial: Partial<PluginListDTO>): PluginListDTO {
  return {
    id: 'test.id',
    name: 'Test',
    version: '1.0.0',
    description: '',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
    ...partial,
  }
}

describe('avatarToneFor', () => {
  it('is deterministic for the same id', () => {
    expect(avatarToneFor('test.demo-config')).toEqual(
      avatarToneFor('test.demo-config')
    )
  })

  it('distributes 100 random ids across the palette', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 100; i++) {
      const id = `random-${i}`
      const tone = avatarToneFor(id)
      counts.set(tone.bg, (counts.get(tone.bg) ?? 0) + 1)
    }
    expect(counts.size).toBeGreaterThanOrEqual(4)
  })

  it('returns a stable ColorTone for an empty id', () => {
    const tone = avatarToneFor('')
    expect(tone.bg).toMatch(/^bg-/)
    expect(tone.text).toMatch(/^text-/)
  })
})

describe('abbreviatePluginName', () => {
  it('takes initials of multi-word names', () => {
    expect(abbreviatePluginName('Demo Config Plugin')).toBe('DC')
    expect(abbreviatePluginName('Video Helper')).toBe('VH')
    expect(abbreviatePluginName('Tracker Monitor')).toBe('TM')
  })

  it('handles kebab-case and snake_case', () => {
    expect(abbreviatePluginName('motrix-bt')).toBe('MB')
    expect(abbreviatePluginName('motrix_aria2_session')).toBe('MA')
  })

  it('uses first 2 chars for single-token names', () => {
    expect(abbreviatePluginName('Video')).toBe('VI')
  })

  it('handles CJK names by taking first chars', () => {
    expect(abbreviatePluginName('视频助手')).toBe('视频')
  })

  it('returns "??" for an empty name', () => {
    expect(abbreviatePluginName('')).toBe('??')
  })

  it('handles names with only non-letters', () => {
    expect(abbreviatePluginName('---')).toBe('??')
  })
})

describe('truncateOneLine', () => {
  it('returns short input unchanged', () => {
    expect(truncateOneLine('A short one.')).toBe('A short one.')
  })

  it('takes the first English sentence', () => {
    expect(truncateOneLine('First. Second sentence is longer.')).toBe('First.')
  })

  it('takes the first Chinese sentence', () => {
    expect(truncateOneLine('第一句话。第二句话更长。')).toBe('第一句话。')
  })

  it('truncates by character cap when no sentence boundary', () => {
    const input = 'a'.repeat(120)
    expect(truncateOneLine(input, 90)).toHaveLength(90)
  })

  it('returns an empty string for an empty input', () => {
    expect(truncateOneLine('')).toBe('')
  })
})

describe('isBroadHostAccess', () => {
  it('returns false for empty or missing hosts', () => {
    expect(isBroadHostAccess([])).toBe(false)
    expect(isBroadHostAccess(undefined)).toBe(false)
  })

  it('returns false for specific hosts', () => {
    expect(isBroadHostAccess(['https://*.video.example/*'])).toBe(false)
  })

  it('returns true for *://*/* pattern', () => {
    expect(isBroadHostAccess(['*://*/*'])).toBe(true)
  })

  it('returns true for <all_urls>', () => {
    expect(isBroadHostAccess(['<all_urls>'])).toBe(true)
  })

  it('returns true if any entry is broad', () => {
    expect(isBroadHostAccess(['https://example.com/*', '*://*/*'])).toBe(true)
  })
})

describe('permissionAudience', () => {
  it('maps storage to optional tone', () => {
    const r = permissionAudience('storage', fakeT as never)
    expect(r.tone).toBe('optional')
    expect(r.strong).toBe('plugins.permission.storage.strong')
  })

  it('maps notifications to off tone', () => {
    const r = permissionAudience('notifications', fakeT as never)
    expect(r.tone).toBe('off')
  })

  it('maps network and any host:* to review tone', () => {
    expect(permissionAudience('network', fakeT as never).tone).toBe('review')
    expect(permissionAudience('host:foo.com', fakeT as never).tone).toBe(
      'review'
    )
  })

  it('maps plugin manifest capability ids used by sample plugins', () => {
    expect(permissionAudience('http', fakeT as never).strong).toBe(
      'plugins.permission.http.strong'
    )
    expect(permissionAudience('http.cookies', fakeT as never).strong).toBe(
      'plugins.permission.http.cookies.strong'
    )
    expect(permissionAudience('ffmpeg', fakeT as never).strong).toBe(
      'plugins.permission.ffmpeg.strong'
    )
    expect(permissionAudience('notify', fakeT as never).strong).toBe(
      'plugins.permission.notify.strong'
    )
  })

  it('maps tasks:read to optional and tasks:write to review', () => {
    expect(permissionAudience('tasks:read', fakeT as never).tone).toBe(
      'optional'
    )
    expect(permissionAudience('tasks:write', fakeT as never).tone).toBe(
      'review'
    )
  })

  it('falls back to unknown for unrecognized names', () => {
    const r = permissionAudience('something.else', fakeT as never)
    expect(r.tone).toBe('review')
    expect(r.strong).toBe('something.else')
  })
})

describe('summarizeAccess', () => {
  it('returns "own settings only" for empty hosts', () => {
    expect(summarizeAccess([], fakeT as never)).toBe(
      'plugins.detail.accessNone'
    )
  })

  it('returns "any website" for broad hosts', () => {
    expect(summarizeAccess(['*://*/*'], fakeT as never)).toBe(
      'plugins.detail.accessBroad'
    )
  })

  it('returns count for specific hosts', () => {
    expect(
      summarizeAccess(['https://a.com/*', 'https://b.com/*'], fakeT as never)
    ).toBe('plugins.detail.accessHosts')
  })
})

describe('summarizeHealth', () => {
  it('returns "off" when plugin disabled', () => {
    expect(summarizeHealth(plugin({ enabled: false }), fakeT as never)).toBe(
      'plugins.detail.hero.off'
    )
  })

  it('returns "no issues" when errorCount is zero', () => {
    expect(summarizeHealth(plugin({ errorCount: 0 }), fakeT as never)).toBe(
      'plugins.detail.healthOk'
    )
  })

  it('returns count when errorCount > 0', () => {
    expect(summarizeHealth(plugin({ errorCount: 2 }), fakeT as never)).toBe(
      'plugins.detail.healthIssues'
    )
  })
})

describe('computePluginAudience', () => {
  it('row 1: enabled + no host + no error => safe', () => {
    const r = computePluginAudience(
      plugin({ enabled: true, status: 'active', errorCount: 0 }),
      undefined,
      fakeT as never,
      undefined
    )
    expect(r.tone).toBe('safe')
  })

  it('row 2: enabled + broad host + no error => review', () => {
    const r = computePluginAudience(
      plugin({ enabled: true, errorCount: 0 }),
      ['*://*/*'],
      fakeT as never,
      undefined
    )
    expect(r.tone).toBe('review')
  })

  it('row 3: enabled + errorCount > 0 => review (error)', () => {
    const r = computePluginAudience(
      plugin({ enabled: true, errorCount: 2 }),
      undefined,
      fakeT as never,
      undefined
    )
    expect(r.tone).toBe('review')
    expect(r.primaryAction.kind).toBe('viewIssue')
  })

  it('row 4: disabled => off', () => {
    const r = computePluginAudience(
      plugin({ enabled: false, status: 'disabled' }),
      undefined,
      fakeT as never,
      undefined
    )
    expect(r.tone).toBe('off')
    expect(r.primaryAction.kind).toBe('turnOn')
  })

  it('row 5: optional permissions ungranted => optional', () => {
    const r = computePluginAudience(
      plugin({
        enabled: true,
        errorCount: 0,
        optionalPermissions: ['notifications'],
      }),
      undefined,
      fakeT as never,
      { notifications: 'denied' }
    )
    expect(r.tone).toBe('optional')
  })

  it('breaker-disabled (enabled=true, status=disabled) => review', () => {
    const r = computePluginAudience(
      plugin({ enabled: true, status: 'disabled', errorCount: 0 }),
      undefined,
      fakeT as never,
      undefined
    )
    expect(r.tone).toBe('review')
  })

  it('primary action: safe + has schema => settings', () => {
    const r = computePluginAudience(
      plugin({ enabled: true, errorCount: 0 }),
      undefined,
      fakeT as never,
      undefined,
      true
    )
    expect(r.primaryAction.kind).toBe('settings')
  })

  it('primary action: safe + no schema => open', () => {
    const r = computePluginAudience(
      plugin({ enabled: true, errorCount: 0 }),
      undefined,
      fakeT as never,
      undefined,
      false
    )
    expect(r.primaryAction.kind).toBe('open')
  })
})
