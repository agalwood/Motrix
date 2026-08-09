import { describe, expect, it } from 'vitest'
import { isTyping, matchesAccelerator } from './match'

function ev(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: overrides.key ?? 'n',
    metaKey: overrides.metaKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
    target: overrides.target ?? null,
  } as KeyboardEvent
}

describe('matchesAccelerator', () => {
  it('matches CommandOrControl+N via ctrl', () => {
    expect(
      matchesAccelerator(ev({ key: 'n', ctrlKey: true }), 'CommandOrControl+N')
    ).toBe(true)
  })
  it('matches CommandOrControl+N via meta (mac)', () => {
    expect(
      matchesAccelerator(ev({ key: 'n', metaKey: true }), 'CommandOrControl+N')
    ).toBe(true)
  })
  it('rejects without modifier', () => {
    expect(matchesAccelerator(ev({ key: 'n' }), 'CommandOrControl+N')).toBe(
      false
    )
  })
  it('matches CommandOrControl+Shift+P', () => {
    expect(
      matchesAccelerator(
        ev({ key: 'p', ctrlKey: true, shiftKey: true }),
        'CommandOrControl+Shift+P'
      )
    ).toBe(true)
  })
  it('rejects when extra modifier pressed', () => {
    expect(
      matchesAccelerator(
        ev({ key: 'n', ctrlKey: true, altKey: true }),
        'CommandOrControl+N'
      )
    ).toBe(false)
  })
})

describe('isTyping', () => {
  it('detects INPUT/TEXTAREA/contentEditable', () => {
    expect(isTyping({ tagName: 'INPUT' } as HTMLElement)).toBe(true)
    expect(isTyping({ tagName: 'TEXTAREA' } as HTMLElement)).toBe(true)
    expect(
      isTyping({ tagName: 'DIV', isContentEditable: true } as HTMLElement)
    ).toBe(true)
  })
  it('returns false otherwise', () => {
    expect(
      isTyping({ tagName: 'DIV', isContentEditable: false } as HTMLElement)
    ).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})
