import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaijiProcessManager } from './taiji-process-manager'

class VersionProbe extends TaijiProcessManager {
  parse(output: string) {
    return this.parseVersionOutput(output)
  }
}

describe('taiji version identity', () => {
  it('admits the actual pinned engine through the process probe', () => {
    const lock = JSON.parse(
      readFileSync(path.resolve('scripts/engine.lock.json'), 'utf8')
    ) as { version: string }
    expect(
      new VersionProbe().parse(`taiji taiji/${lock.version}\n`)?.version
    ).toBe(`taiji/${lock.version}`)
  })
  it.each(['taiji/0.2.0', 'taiji/0.3.0-beta.1', 'taiji/1.0.0+build.1'])(
    'accepts standard SemVer: %s',
    (version) => {
      expect(new VersionProbe().parse(`taiji ${version}`)?.version).toBe(
        version
      )
    }
  )
  it.each(['aria2 1.37.0', 'taiji invalid', 'taiji taiji/not-a-version'])(
    'rejects an invalid identity: %s',
    (output) => {
      expect(new VersionProbe().parse(output)).toBeNull()
    }
  )
})
