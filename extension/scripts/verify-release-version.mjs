import { readFileSync } from 'node:fs'

const expectedVersion = process.argv[2]

if (!expectedVersion) {
  throw new Error('Expected the release version as the first argument')
}

for (const variant of ['webstore', 'firefox']) {
  const manifest = JSON.parse(
    readFileSync(new URL(`../dist/${variant}/manifest.json`, import.meta.url))
  )

  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${variant} manifest version ${manifest.version} does not match ${expectedVersion}`
    )
  }
}

console.log(`Verified release manifest version ${expectedVersion}`)
