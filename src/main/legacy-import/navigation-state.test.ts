import { describe, expect, it, vi } from 'vitest'
import { LegacyImportNavigation } from './navigation-state'

function fixture(sources: Array<{ sourceHandle: string; name: string }> = []) {
  const service = {
    discover: vi.fn(async () => sources),
    invitationDismissed: vi.fn(() => false),
  }
  const deps = {
    hasConsent: vi.fn(() => true),
    getService: () => service,
    roots: vi.fn(() => ['/old']),
    changed: vi.fn(),
  }
  return { navigation: new LegacyImportNavigation(deps), deps, service }
}
describe('legacy main navigation state', () => {
  it('never reads old roots before consent', async () => {
    const f = fixture()
    f.deps.hasConsent.mockReturnValue(false)
    await expect(f.navigation.detect()).rejects.toThrow('consentRequired')
    expect(f.deps.roots).not.toHaveBeenCalled()
    expect(f.service.discover).not.toHaveBeenCalled()
  })
  it('keeps an empty detected v1 source visible after skip or completed invitation', async () => {
    const f = fixture([{ sourceHandle: 'old', name: 'Motrix' }])
    expect(await f.navigation.detect()).toEqual({
      detected: true,
      invitationPending: true,
    })
    f.navigation.finishInvitation()
    expect(f.navigation.getState()).toEqual({
      detected: true,
      invitationPending: false,
    })
    const next = fixture([{ sourceHandle: 'old', name: 'Motrix' }])
    next.service.invitationDismissed.mockReturnValue(true)
    expect(await next.navigation.detect()).toEqual({
      detected: true,
      invitationPending: false,
    })
  })
  it('does not pretend a failed detection found v1 and permits a later retry', async () => {
    const f = fixture()
    f.service.discover.mockRejectedValueOnce(new Error('unavailable'))
    await expect(f.navigation.detect()).rejects.toThrow('unavailable')
    expect(f.navigation.getState().detected).toBe(false)
    expect(await f.navigation.detect()).toEqual({
      detected: false,
      invitationPending: false,
    })
  })
  it('does not lose a manually validated source to an older empty default discovery', async () => {
    const f = fixture()
    let done!: (sources: []) => void
    f.service.discover.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const pending = f.navigation.detect()
    f.navigation.sourceDetected()
    done([])
    expect(await pending).toEqual({ detected: true, invitationPending: false })
  })
  it('does not publish a discovery result during shutdown', async () => {
    const f = fixture()
    let done!: (sources: Array<{ sourceHandle: string; name: string }>) => void
    f.service.discover.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const pending = f.navigation.detect()
    f.deps.hasConsent.mockReturnValue(false)
    done([{ sourceHandle: 'old', name: 'Motrix' }])
    expect(await pending).toEqual({ detected: false, invitationPending: false })
    expect(f.deps.changed).not.toHaveBeenCalled()
  })
})
