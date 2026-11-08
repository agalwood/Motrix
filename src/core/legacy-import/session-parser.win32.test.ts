import { describe, expect, it } from 'vitest'
import { safeLegacyDirectory, safeLegacyOutput } from './session-parser'

describe.skipIf(process.platform !== 'win32')(
  'legacy Windows drive paths',
  () => {
    it('canonicalizes the drive letter without folding directory or filename case', () => {
      expect(safeLegacyDirectory('c:\\Users\\Name\\下载')).toBe(
        'C:\\Users\\Name\\下载'
      )
      expect(safeLegacyOutput('d:\\Downloads', 'Original.Name')).toBe(
        'D:\\Downloads\\Original.Name'
      )
    })

    it('refuses drive-relative paths and volume roots', () => {
      expect(safeLegacyDirectory('C:Downloads')).toBeNull()
      expect(safeLegacyDirectory('c:\\')).toBeNull()
    })
  }
)
