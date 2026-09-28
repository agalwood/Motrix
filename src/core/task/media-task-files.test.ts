import type { SegmentPlan } from '@core/media/segment-plan'
import { describe, expect, it } from 'vitest'
import {
  createMediaTaskFiles,
  toMediaTaskFiles,
  updateMediaTaskFile,
} from './media-task-files'

const plan: SegmentPlan = {
  container: 'fmp4',
  isComplete: true,
  init: { url: 'https://cdn.example/init.mp4?token=secret' },
  segments: [
    {
      index: 0,
      url: 'https://cdn.example/video.mp4?token=secret',
      byteRange: { offset: 100, length: 50 },
    },
    {
      index: 1,
      url: 'https://cdn.example/video.mp4?token=secret',
      byteRange: { offset: 150, length: 60 },
    },
  ],
}

describe('media task files', () => {
  it('lists every init and segment in stream order with unique indices and no URL credentials', () => {
    const files = toMediaTaskFiles([
      ...createMediaTaskFiles(plan, 'video'),
      ...createMediaTaskFiles({ ...plan, init: undefined }, 'audio'),
    ])
    expect(files?.map((file) => file.path)).toEqual([
      'video/init-init.mp4',
      'video/000001-video.mp4',
      'video/000002-video.mp4',
      'audio/000001-video.mp4',
      'audio/000002-video.mp4',
    ])
    expect(files?.map((file) => file.index)).toEqual([0, 1, 2, 3, 4])
    expect(files?.map((file) => file.size)).toEqual([0, 50, 60, 50, 60])
    expect(files?.every((file) => file.selected && file.progress === 0)).toBe(
      true
    )
    expect(JSON.stringify(files)).not.toContain('secret')
  })

  it('retains stream-specific progress in metadata and keeps unknown-size completions at 100%', () => {
    const video = createMediaTaskFiles(plan, 'video')
    const audio = createMediaTaskFiles({ ...plan, init: undefined }, 'audio')
    updateMediaTaskFile(video, {
      index: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      completed: true,
    })
    updateMediaTaskFile(audio, {
      index: 1,
      downloadedBytes: 30,
      totalBytes: 60,
      completed: false,
    })
    const files = toMediaTaskFiles([...video, ...audio])
    expect(files?.[0]).toMatchObject({ size: 0, progress: 1 })
    expect(files?.[2]).toMatchObject({ completedBytes: 0, progress: 0 })
    expect(files?.[4]).toMatchObject({ completedBytes: 30, progress: 0.5 })

    updateMediaTaskFile(audio, {
      index: 1,
      downloadedBytes: 0,
      totalBytes: 0,
      completed: false,
    })
    expect(toMediaTaskFiles(audio)[1]).toMatchObject({
      size: 60,
      completedBytes: 0,
      progress: 0,
    })
  })
})
