import { TaskStatus } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { getProgressBarTone, getStatusTone, rtlMirror } from './task-status-ui'

describe('task-status-ui', () => {
  it('maps each status to a tone object', () => {
    const blue = getStatusTone(TaskStatus.Downloading)
    expect(blue.bg).toContain('blue')
    expect(blue.text).toContain('blue')
    const err = getStatusTone(TaskStatus.Error)
    expect(err.bg).toContain('red')
    const ok = getStatusTone(TaskStatus.Completed)
    expect(ok.bg).toContain('slate')
  })
  it('progress bar tone follows status color', () => {
    expect(getProgressBarTone(TaskStatus.Paused)).toContain('amber')
    expect(getProgressBarTone(TaskStatus.Error)).toContain('red')
    expect(getProgressBarTone(TaskStatus.Seeding)).toContain('green')
  })
  it('exposes rtlMirror helper', () => {
    expect(rtlMirror).toBe('rtl:-scale-x-100')
  })
})
