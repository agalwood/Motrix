import type { DownloadTask } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { classifyDownload, taskDownloadCategory } from './download-category'

describe('download categories', () => {
  it.each([
    ['archive.tar.gz', 'compressed'],
    ['BACKUP.7Z', 'compressed'],
    ['report.PDF', 'documents'],
    ['lesson.docx', 'documents'],
    ['song.FLAC', 'music'],
    ['voice.opus', 'music'],
    ['setup.MSI', 'programs'],
    ['app.AppImage', 'programs'],
    ['movie.MKV', 'video'],
    ['clip.mp4', 'video'],
    ['picture.png', 'other'],
    ['download', 'other'],
    ['.env', 'other'],
    ['C:\\Downloads\\release.exe', 'programs'],
    ['/files/lesson.epub', 'documents'],
  ])('classifies %s as %s', (name, category) => {
    expect(classifyDownload(name)).toBe(category)
  })

  it('classifies existing history by its final filename without changing it', () => {
    const task = {
      category: null,
      finalName: 'movie.mp4',
      saveDir: '/old',
      fileCount: 1,
    } as DownloadTask
    expect(taskDownloadCategory(task)).toBe('video')
    expect(task.saveDir).toBe('/old')
    expect(task.category).toBeNull()
  })

  it('keeps multi-file payloads together under Other', () => {
    expect(
      taskDownloadCategory({
        fileCount: 3,
        finalName: 'collection.mp4',
      } as DownloadTask)
    ).toBe('other')
  })
})
