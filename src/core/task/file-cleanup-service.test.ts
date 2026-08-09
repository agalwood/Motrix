import { TaskType } from '@shared/types/task'
import { describe, expect, it, vi } from 'vitest'
import { FileCleanupServiceImpl } from './file-cleanup-service'

function makeFs() {
  return {
    removePathRecursive: vi.fn(async () => {}),
  }
}

describe('FileCleanupService.cleanup', () => {
  it('HTTP: removes diskPath and .aria2 sidecar', async () => {
    const fs = makeFs()
    const svc = new FileCleanupServiceImpl(fs)
    await svc.cleanup('/d/foo.mp4.motrix', TaskType.Http)

    expect(fs.removePathRecursive).toHaveBeenCalledWith('/d/foo.mp4.motrix')
    expect(fs.removePathRecursive).toHaveBeenCalledWith(
      '/d/foo.mp4.motrix.aria2'
    )
  })

  it('BT: removes container directory (no sidecar path passed)', async () => {
    const fs = makeFs()
    const svc = new FileCleanupServiceImpl(fs)
    await svc.cleanup('/d/name.motrix', TaskType.Bt)

    expect(fs.removePathRecursive).toHaveBeenCalledWith('/d/name.motrix')
    expect(fs.removePathRecursive).not.toHaveBeenCalledWith(
      '/d/name.motrix.aria2'
    )
  })

  it('completed HTTP task (no .motrix suffix): removes file + no sidecar', async () => {
    const fs = makeFs()
    const svc = new FileCleanupServiceImpl(fs)
    await svc.cleanup('/d/foo.mp4', TaskType.Http)

    expect(fs.removePathRecursive).toHaveBeenCalledWith('/d/foo.mp4')
  })
})
