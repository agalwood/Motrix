import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')(
  'recovers Snap uploads without duplicate writes or mixed provenance',
  () => {
    const result = spawnSync(
      'python3',
      ['tests/scripts/test_snap_publication.py'],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      }
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }
)
