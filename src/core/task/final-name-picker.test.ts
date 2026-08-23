import { AppError } from '@shared/errors'
import { describe, expect, it, vi } from 'vitest'
import { FinalNamePickerImpl } from './final-name-picker'

function makeFs(existing: Set<string>) {
  return {
    exists: vi.fn(async (p: string) => existing.has(p)),
  }
}

describe('FinalNamePicker.pick', () => {
  it('returns original name when no collision', async () => {
    const picker = new FinalNamePickerImpl(makeFs(new Set()))
    expect(await picker.pick('/d', 'foo.mp4')).toBe('foo.mp4')
  })

  it('appends " (1)" on single collision', async () => {
    const picker = new FinalNamePickerImpl(makeFs(new Set(['/d/foo.mp4'])))
    expect(await picker.pick('/d', 'foo.mp4')).toBe('foo (1).mp4')
  })

  it('considers .motrix variants as collisions', async () => {
    const picker = new FinalNamePickerImpl(
      makeFs(new Set(['/d/foo.mp4.motrix']))
    )
    expect(await picker.pick('/d', 'foo.mp4')).toBe('foo (1).mp4')
  })

  it('reserves names owned by tasks whose payload is still staged elsewhere', async () => {
    const picker = new FinalNamePickerImpl(makeFs(new Set()))
    expect(await picker.pick('/d', 'foo.mp4', ['foo.mp4'])).toBe('foo (1).mp4')
  })

  it('increments through (1), (2), (3)', async () => {
    const picker = new FinalNamePickerImpl(
      makeFs(new Set(['/d/foo.mp4', '/d/foo (1).mp4', '/d/foo (2).mp4']))
    )
    expect(await picker.pick('/d', 'foo.mp4')).toBe('foo (3).mp4')
  })

  it('handles file without extension', async () => {
    const picker = new FinalNamePickerImpl(makeFs(new Set(['/d/README'])))
    expect(await picker.pick('/d', 'README')).toBe('README (1)')
  })

  it('handles dotfiles (.hidden)', async () => {
    const picker = new FinalNamePickerImpl(makeFs(new Set(['/d/.env'])))
    expect(await picker.pick('/d', '.env')).toBe('.env (1)')
  })

  it('handles multi-dot names (archive.tar.gz)', async () => {
    const picker = new FinalNamePickerImpl(
      makeFs(new Set(['/d/archive.tar.gz']))
    )
    expect(await picker.pick('/d', 'archive.tar.gz')).toBe('archive.tar (1).gz')
  })

  it('appends suffix at end when trailing dot-token has spaces/parens (BT folder)', async () => {
    // Real-world BT folder name reported by user. path.extname() would
    // return ".1 Tigole)" — spaces and parens are not a real extension,
    // so the suffix must go at the end of the whole name.
    const name =
      'The Godfather (1972) RM4K REPACK ' +
      '(1080p BluRay x265 HEVC 10bit AAC 5.1 Tigole)'
    const picker = new FinalNamePickerImpl(makeFs(new Set([`/d/${name}`])))
    expect(await picker.pick('/d', name)).toBe(`${name} (1)`)
  })

  it('appends suffix at end for version-like names (no real extension)', async () => {
    const picker = new FinalNamePickerImpl(
      makeFs(new Set(['/d/Project v1.2.3']))
    )
    expect(await picker.pick('/d', 'Project v1.2.3')).toBe('Project v1.2.3 (1)')
  })

  it('throws AppError when dedup exhausted at 9999', async () => {
    // Seed with 10000 collisions
    const collisions = new Set<string>(['/d/x.txt'])
    for (let i = 1; i <= 9999; i++) {
      collisions.add(`/d/x (${i}).txt`)
    }
    const picker = new FinalNamePickerImpl(makeFs(collisions))
    await expect(picker.pick('/d', 'x.txt')).rejects.toThrow(AppError)
  })
})
