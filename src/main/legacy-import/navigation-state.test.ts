import type { LegacyImportSource } from '@shared/schemas/legacy-import'
import { describe, expect, it, vi } from 'vitest'
import { LegacyImportNavigation } from './navigation-state'

function fixture(sources: LegacyImportSource[] = []) {
  let dismissed = false
  const service = {
    discover: vi.fn(async () => sources),
    invitationDismissed: vi.fn(() => dismissed),
    dismissInvitation: vi.fn(() => {
      dismissed = true
    }),
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
    const f = fixture([
      { sourceHandle: 'old', name: 'Motrix', dataPath: '/old' },
    ])
    expect(await f.navigation.detect()).toEqual({
      detected: true,
      invitationPending: true,
    })
    f.navigation.finishInvitation()
    expect(f.navigation.getState()).toEqual({
      detected: true,
      invitationPending: false,
    })
    const next = fixture([
      { sourceHandle: 'old', name: 'Motrix', dataPath: '/old' },
    ])
    next.service.invitationDismissed.mockReturnValue(true)
    expect(await next.navigation.detect()).toEqual({
      detected: true,
      invitationPending: false,
    })
  })
  it('persists the first invitation even if the user leaves without choosing', async () => {
    const f = fixture([
      { sourceHandle: 'old', name: 'Motrix', dataPath: '/old' },
    ])
    expect(await f.navigation.detect()).toEqual({
      detected: true,
      invitationPending: true,
    })
    await f.navigation.detect()
    expect(f.service.dismissInvitation).toHaveBeenCalledTimes(1)
    // A new navigation instance models restarting with the same persisted flag.
    const restarted = new LegacyImportNavigation(f.deps)
    expect(await restarted.detect()).toEqual({
      detected: true,
      invitationPending: false,
    })
    expect(f.service.dismissInvitation).toHaveBeenCalledTimes(1)
    restarted.sourceDetected()
    expect(restarted.getState().detected).toBe(true)
  })
  it('does not return a consumed invitation from its cached discovery', async () => {
    const f = fixture([
      { sourceHandle: 'old', name: 'Motrix', dataPath: '/old' },
    ])
    await f.navigation.detect()
    f.navigation.finishInvitation()
    expect(await f.navigation.detect()).toEqual({
      detected: true,
      invitationPending: false,
    })
  })

  it('does not consume the invitation when no v1 source is found', async () => {
    const f = fixture()
    await f.navigation.detect()
    expect(f.service.dismissInvitation).not.toHaveBeenCalled()
  })
  it('does not invite until its consumed state can be persisted', async () => {
    const f = fixture([
      { sourceHandle: 'old', name: 'Motrix', dataPath: '/old' },
    ])
    f.service.dismissInvitation.mockImplementationOnce(() => {
      throw new Error('storage unavailable')
    })
    await expect(f.navigation.detect()).rejects.toThrow('storage unavailable')
    expect(f.navigation.getState().invitationPending).toBe(false)
    expect((await f.navigation.detect()).invitationPending).toBe(true)
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
    let done!: (sources: LegacyImportSource[]) => void
    f.service.discover.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const pending = f.navigation.detect()
    f.deps.hasConsent.mockReturnValue(false)
    done([{ sourceHandle: 'old', name: 'Motrix', dataPath: '/old' }])
    expect(await pending).toEqual({ detected: false, invitationPending: false })
    expect(f.deps.changed).not.toHaveBeenCalled()
  })
})
