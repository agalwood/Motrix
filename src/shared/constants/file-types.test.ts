import { describe, expect, it } from 'vitest'
import {
  containsOnlyVideoFiles,
  isVideoFilePath,
  VIDEO_FILE_EXTENSIONS,
} from './file-types'

describe('video file classification', () => {
  it('matches the shared video extension list case-insensitively', () => {
    expect(isVideoFilePath('Movie.MP4')).toBe(true)
    expect(isVideoFilePath('folder/episode.rMvB')).toBe(true)
    expect(isVideoFilePath('movie.mp4.part')).toBe(false)
    expect(VIDEO_FILE_EXTENSIONS).toContain('.mkv')
  })

  it('requires every declared file to be a video', () => {
    expect(containsOnlyVideoFiles(['movie.mkv', 'extras/trailer.webm'])).toBe(
      true
    )
    expect(containsOnlyVideoFiles(['movie.mkv', 'readme.txt'])).toBe(false)
    expect(containsOnlyVideoFiles([])).toBe(false)
  })
})
