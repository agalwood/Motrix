// Invoked by the isolated root suite after dropping UID and GID.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [modulePath, socketPath, authorityKey, cancelled] = process.argv.slice(2)
assert.notEqual(process.geteuid(), 0)
for (const file of ['/etc/shadow', authorityKey])
  await assert.rejects(readFile(file), (error) => error.code === 'EACCES')
const { FnosAccountAuthority } = await import(pathToFileURL(modulePath).href)
const controller = new AbortController()
if (cancelled === 'true') controller.abort()
const identity = await new FnosAccountAuthority(socketPath).resolve(
  {
    platform: 'fnos',
    userId: '1700',
    username: 'alice',
    administrator: true,
  },
  controller.signal
)
process.stdout.write(JSON.stringify(identity))
