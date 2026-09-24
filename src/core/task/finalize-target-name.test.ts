import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolvePublishedTargetPath } from './finalize-target-name'

describe('resolvePublishedTargetPath', () => {
  it('keeps an already-clean target untouched and never re-picks it', async () => {
    // A clean name was deduplicated when the task was created; picking again
    // would collide with the task's own `.motrix` reservation.
    const picker = { pick: vi.fn() }
    expect(
      await resolvePublishedTargetPath(path.join('/d', 'foo.mp4'), picker)
    ).toBe(path.join('/d', 'foo.mp4'))
    expect(picker.pick).not.toHaveBeenCalled()
  })

  it('deduplicates a sanitized name against what already exists', async () => {
    // `a:b.txt` sanitizes to `a_b.txt`, which nobody reserved at create time.
    const picker = { pick: vi.fn(async () => 'a_b (1).txt') }
    expect(
      await resolvePublishedTargetPath(path.join('/d', 'a:b.txt'), picker)
    ).toBe(path.join('/d', 'a_b (1).txt'))
    expect(picker.pick).toHaveBeenCalledWith(path.join('/d'), 'a_b.txt')
  })

  it('returns the sanitized name when the picker finds it free', async () => {
    const picker = { pick: vi.fn(async (_dir: string, name: string) => name) }
    expect(
      await resolvePublishedTargetPath(path.join('/d', 'CON.txt'), picker)
    ).toBe(path.join('/d', 'CON_.txt'))
  })

  it('still sanitizes when no picker is wired', async () => {
    expect(
      await resolvePublishedTargetPath(path.join('/d', 'a:b.txt'), undefined)
    ).toBe(path.join('/d', 'a_b.txt'))
  })
})
