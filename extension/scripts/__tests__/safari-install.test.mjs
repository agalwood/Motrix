import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installSafariApp } from '../safari-install-transaction.mjs'

function fixture(t, installed = true) {
  const root = mkdtempSync(join(tmpdir(), 'motrix-safari-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'build/Motrix.app')
  const destination = join(root, 'Applications/Motrix.app')
  const contents = (path) => readFileSync(join(path, 'bundle.json'), 'utf8')
  const put = (path, build, fingerprint = String(build)) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'bundle.json'),
      JSON.stringify({ build, fingerprint })
    )
  }
  put(source, 2)
  if (installed) put(destination, 1)
  const calls = []
  const registry = {
    unregister: (path) => calls.push(['unregister', path]),
    register: (path) => calls.push(['register', path]),
  }
  const verify = (path) => JSON.parse(contents(path))
  const options = { source, destination, verify, registry, apply: true }
  return {
    root,
    source,
    destination,
    contents,
    put,
    calls,
    registry,
    verify,
    options,
  }
}

test('preflight validates without creating Applications or registering anything', (t) => {
  const f = fixture(t, false)
  assert.equal(installSafariApp({ ...f.options, apply: false }).status, 'ready')
  assert.equal(existsSync(join(f.root, 'Applications')), false)
  assert.deepEqual(f.calls, [])
})

test('identical builds are a no-op and replacements require a newer version', (t) => {
  const f = fixture(t)
  f.put(f.destination, 2)
  assert.equal(installSafariApp(f.options).status, 'up-to-date')
  f.put(f.source, 2, 'changed')
  assert.throws(() => installSafariApp(f.options), /newer CFBundleVersion/)
  f.put(f.source, 1)
  assert.throws(() => installSafariApp(f.options), /newer CFBundleVersion/)
  assert.equal(f.verify(f.destination).build, 2)
  assert.deepEqual(f.calls, [])
})

test('replacement keeps the installed path registered and retains an exact backup', (t) => {
  const f = fixture(t)
  const old = f.contents(f.destination)
  const result = installSafariApp(f.options)
  assert.equal(result.status, 'installed')
  assert.equal(f.contents(result.backup), old)
  assert.equal(f.contents(f.destination), f.contents(f.source))
  assert.deepEqual(f.calls, [
    ['unregister', f.source],
    ['register', f.destination],
  ])
  assert.equal(
    existsSync(join(f.root, 'Applications/.motrix-safari-install.lock')),
    false
  )
})

test('a failed registration restores the old bundle at its original path', (t) => {
  const f = fixture(t)
  const old = f.contents(f.destination)
  f.registry.register = (path) => {
    f.calls.push(['register', path])
    if (f.verify(path).build === 2) throw new Error('Registration failed')
  }
  assert.throws(
    () => installSafariApp(f.options),
    (error) => {
      assert.match(error.message, /previous state was restored/)
      assert.match(error.cause.message, /Registration failed/)
      return true
    }
  )
  assert.equal(f.contents(f.destination), old)
  assert.deepEqual(f.calls.at(-1), ['register', f.destination])
  assert.deepEqual(readdirSync(join(f.root, 'Applications')), ['Motrix.app'])
})

test('invalid source or existing destination fails before any mutation', (t) => {
  const f = fixture(t)
  for (const rejected of [f.source, f.destination]) {
    assert.throws(
      () =>
        installSafariApp({
          ...f.options,
          verify: (path) => {
            if (path === rejected) throw new Error('Untrusted bundle')
            return f.verify(path)
          },
        }),
      /Untrusted bundle/
    )
  }
  assert.equal(f.verify(f.destination).build, 1)
  assert.deepEqual(f.calls, [])
})

test('a corrupt staged copy leaves the installed app and registrations untouched', (t) => {
  const f = fixture(t)
  assert.throws(
    () =>
      installSafariApp({
        ...f.options,
        verify: (path) =>
          path.endsWith('incoming.app.disabled')
            ? { build: 2, fingerprint: 'corrupt' }
            : f.verify(path),
      }),
    /previous state was restored/
  )
  assert.equal(f.verify(f.destination).build, 1)
  assert.deepEqual(f.calls, [])
})

test('post-move validation failure rolls back before registering the new bundle', (t) => {
  const f = fixture(t)
  assert.throws(
    () =>
      installSafariApp({
        ...f.options,
        verify: (path) => {
          const info = f.verify(path)
          if (path === f.destination && info.build === 2)
            throw new Error('Invalid copy')
          return info
        },
      }),
    /previous state was restored/
  )
  assert.equal(f.verify(f.destination).build, 1)
  assert.deepEqual(f.calls, [['register', f.destination]])
})

test('first-install failure removes only the newly placed copy', (t) => {
  const f = fixture(t, false)
  f.registry.register = () => {
    throw new Error('Registration failed')
  }
  assert.throws(
    () => installSafariApp(f.options),
    /previous state was restored/
  )
  assert.equal(existsSync(f.destination), false)
  assert.equal(f.verify(f.source).build, 2)
  assert.deepEqual(readdirSync(join(f.root, 'Applications')), [])
})

test('rollback errors are surfaced and recovery files are preserved', (t) => {
  const f = fixture(t)
  f.registry.register = () => {
    throw new Error('Registry unavailable')
  }
  assert.throws(
    () => installSafariApp(f.options),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /recovery needs inspection/)
      assert.equal(error.errors.length, 2)
      return true
    }
  )
  assert.equal(f.verify(f.destination).build, 1)
  assert.ok(
    readdirSync(join(f.root, 'Applications')).some((name) =>
      name.startsWith('.motrix-safari-install-')
    )
  )
})

test('source/destination aliases and symlink targets are rejected', (t) => {
  const f = fixture(t)
  assert.throws(
    () => installSafariApp({ ...f.options, destination: f.source }),
    /separate bundles/
  )
  assert.throws(
    () =>
      installSafariApp({
        ...f.options,
        destination: join(f.source, 'nested.app'),
      }),
    /separate bundles/
  )
  const alias = join(f.root, 'alias.app')
  symlinkSync(f.source, alias)
  assert.throws(
    () => installSafariApp({ ...f.options, source: alias }),
    /not a symlink/
  )
  rmSync(f.destination, { recursive: true })
  symlinkSync(join(f.root, 'missing'), f.destination)
  assert.throws(() => installSafariApp(f.options), /not a symlink/)
  assert.deepEqual(f.calls, [])
})

test('a concurrent installer lock prevents replacement', (t) => {
  const f = fixture(t)
  const lock = join(f.root, 'Applications/.motrix-safari-install.lock')
  mkdirSync(lock)
  assert.throws(() => installSafariApp(f.options), { code: 'EEXIST' })
  assert.equal(f.verify(f.destination).build, 1)
  assert.equal(existsSync(lock), true)
  assert.deepEqual(f.calls, [])
})
