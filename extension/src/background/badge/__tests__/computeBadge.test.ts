import { describe, expect, it } from 'vitest'
import { computeBadge } from '@/background/badge/computeBadge'

const base = {
  connection: 'connected' as const,
  hasActivity: false,
  hasUnackError: false,
}

describe('computeBadge', () => {
  it('connected + idle → colour icon, no badge, connected tooltip', () => {
    const r = computeBadge(base)
    expect(r.icon).toBe('color')
    expect(r.badge).toBeNull()
    expect(r.tooltipKey).toBe('badge.tooltip.connected')
  })

  it('disconnected → grey icon, no badge, disconnected tooltip', () => {
    const r = computeBadge({ ...base, connection: 'disconnected' })
    expect(r.icon).toBe('grey')
    expect(r.badge).toBeNull()
    expect(r.tooltipKey).toBe('badge.tooltip.disconnected')
  })

  it('connected + active → green ↓', () => {
    const r = computeBadge({ ...base, hasActivity: true })
    expect(r.badge).toEqual({ text: '↓', bg: '#12b886', fg: '#ffffff' })
    expect(r.tooltipKey).toBe('badge.tooltip.downloading')
  })

  it.each(['bootstrapping', 'connecting', 'handshaking'] as const)(
    'transitional %s → grey icon without an oversized badge',
    (connection) => {
      const r = computeBadge({ ...base, connection })
      expect(r.icon).toBe('grey')
      expect(r.badge).toBeNull()
      expect(r.tooltipKey).toBe('badge.tooltip.connecting')
    }
  )

  it('denied → grey icon + amber !', () => {
    const r = computeBadge({ ...base, connection: 'denied' })
    expect(r.icon).toBe('grey')
    expect(r.badge).toEqual({ text: '!', bg: '#f0a020', fg: '#ffffff' })
    expect(r.tooltipKey).toBe('badge.tooltip.denied')
  })

  it('error outranks everything (even downloading) → red !', () => {
    const r = computeBadge({
      connection: 'connected',
      hasActivity: true,
      hasUnackError: true,
    })
    expect(r.badge).toEqual({ text: '!', bg: '#e03131', fg: '#ffffff' })
    expect(r.tooltipKey).toBe('badge.tooltip.error')
  })

  it('error while disconnected → grey icon + red !', () => {
    const r = computeBadge({
      connection: 'disconnected',
      hasActivity: false,
      hasUnackError: true,
    })
    expect(r.icon).toBe('grey')
    expect(r.badge?.bg).toBe('#e03131')
  })

  it('error outranks denied', () => {
    const r = computeBadge({
      connection: 'denied',
      hasActivity: false,
      hasUnackError: true,
    })
    expect(r.badge?.bg).toBe('#e03131')
  })
})
