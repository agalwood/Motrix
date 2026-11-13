import { describe, expect, it, vi } from 'vitest'
import { TaijiStartupGuard } from './taiji-startup-guard'

const first = '0000000000000001'
const second = '0000000000000002'
function fixture() {
  const completed = new Set<string>()
  const held = new Set<string>()
  const rpc = {
    getGlobalOption: vi.fn().mockResolvedValue({
      'motrix-startup-tasks': JSON.stringify([
        [first, true],
        [second, true],
      ]),
    }),
    tellStatus: vi.fn().mockResolvedValue({ status: 'paused' }),
    forceRemove: vi.fn().mockResolvedValue(first),
    changeGlobalOption: vi.fn().mockResolvedValue('OK'),
  }
  const removeResult = vi.fn().mockResolvedValue(undefined)
  const authorizeResume = vi.fn().mockResolvedValue(true)
  return {
    completed,
    held,
    rpc,
    removeResult,
    authorizeResume,
    guard: new TaijiStartupGuard({
      completedGids: () => completed,
      heldGids: () => held,
      rpc,
      removeResult,
      authorizeResume,
    }),
  }
}
describe('taiji startup authorization', () => {
  it('keeps every remaining task frozen if a completed-task purge fails', async () => {
    const f = fixture()
    f.completed.add(first)
    f.removeResult.mockRejectedValue(new Error('disk failure'))
    await expect(
      (await f.guard.prepare([])).reconcile(() => false)
    ).rejects.toThrow('disk failure')
    expect(f.rpc.changeGlobalOption).not.toHaveBeenCalled()
  })
  it('does not release unauthorized or newly held tasks', async () => {
    const f = fixture()
    f.authorizeResume.mockImplementation(async (gid) => {
      if (gid === second) f.held.add(second)
      return gid === second
    })
    await (await f.guard.prepare([])).reconcile(() => false)
    expect(f.rpc.changeGlobalOption).toHaveBeenCalledWith({
      'motrix-release-startup': '[]',
    })
  })
  it('purges durable terminal rows even if they are absent from the live status window', async () => {
    const f = fixture()
    f.completed.add(first)
    f.rpc.tellStatus.mockRejectedValue(new Error(`GID ${first} is not found`))
    await (await f.guard.prepare([])).reconcile(() => false)
    expect(f.removeResult).toHaveBeenCalledWith(first)
    expect(f.rpc.forceRemove).not.toHaveBeenCalled()
    expect(f.rpc.changeGlobalOption).toHaveBeenCalledWith({
      'motrix-release-startup': JSON.stringify([second]),
    })
  })
  it('rejects a daemon without the startup hold contract', async () => {
    const f = fixture()
    f.rpc.getGlobalOption.mockResolvedValue({})
    await expect(
      (await f.guard.prepare([])).reconcile(() => false)
    ).rejects.toThrow()
    expect(f.rpc.changeGlobalOption).not.toHaveBeenCalled()
  })
})
