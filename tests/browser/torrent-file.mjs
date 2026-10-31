import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, firefox, webkit } from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = `${root}/output/playwright/manual/torrent-core`
await mkdir(output, { recursive: true })
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents:
      "export { parseTorrent, encode, decode, parseMagnet } from '@motrix/torrent'; export { readTorrentFile } from './src/renderer/lib/parse-torrent-file.ts'",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'Torrent',
  platform: 'browser',
  write: false,
})
const files = await Promise.all(
  [
    ['v1', 'test'],
    ['hybrid', 'libtorrent/v2'],
    ['v2', 'libtorrent/v2-only'],
  ].map(async ([name, fixture]) => ({
    name,
    bytes: [
      ...(await readFile(
        new URL(
          `../../src/core/torrent/__fixtures__/${fixture}.torrent`,
          import.meta.url
        )
      )),
    ],
  }))
)
const requested = process.argv.slice(2).filter((argument) => argument !== '--')
const browsers = { chromium, firefox, webkit }
const selected = requested.length ? requested : Object.keys(browsers)
for (const name of selected)
  assert.ok(Object.hasOwn(browsers, name), `Unknown browser: ${name}`)
const results = []
for (const name of selected) {
  const browserType = browsers[name]
  const executablePath =
    process.env[`MOTRIX_TEST_${name.toUpperCase()}_EXECUTABLE`]
  const browser = await browserType.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })
  try {
    const page = await browser.newPage()
    // A non-loopback HTTP origin is deliberately not a secure context. All
    // requests are served locally by routing; no remote service is contacted.
    await page.route('http://torrent.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Torrent browser conformance</title>',
      })
    )
    await page.goto('http://torrent.test/')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(async (fixtures) => {
      const { parseTorrent, encode, decode, parseMagnet, readTorrentFile } =
        globalThis.Torrent
      if (isSecureContext || globalThis.crypto?.subtle)
        throw new Error('Expected HTTP without WebCrypto')
      const hashes = fixtures.map(({ name, bytes }) => {
        const input = new Uint8Array(bytes)
        const parsed = parseTorrent(input)
        if (parsed.infoBytes.buffer !== input.buffer)
          throw new Error('Info bytes were copied')
        return { name, identity: parsed.identity }
      })
      const seed = new Uint8Array(fixtures[0].bytes)
      const file = await readTorrentFile(new File([seed], 'alice.torrent'))
      if (file.base64 !== btoa(String.fromCharCode(...seed)))
        throw new Error('File bytes changed')
      const v2 = new Uint8Array(fixtures.find((f) => f.name === 'v2').bytes)
      let rejected = false
      try {
        await readTorrentFile(new File([v2], 'v2.torrent'))
      } catch (error) {
        rejected = error.code === 'ENGINE_FEATURE_UNAVAILABLE'
      }
      if (!rejected)
        throw new Error('Unsupported v2 reached the engine projection')
      const parsed = decode(
        encode({ large: 9007199254740993n, binary: new Uint8Array([0, 255]) })
      ).value
      if (parsed.get('large') !== 9007199254740993n)
        throw new Error('Integer precision lost')
      if (
        parseMagnet(`magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}`).identity
          .kind !== 'v2'
      )
        throw new Error('v2 magnet identity lost')
      return {
        secureContext: isSecureContext,
        webCrypto: Boolean(globalThis.crypto?.subtle),
        hashes,
        originalFilePreserved: true,
        unsupportedV2Rejected: true,
      }
    }, files)
    assert.equal(
      result.hashes.find((f) => f.name === 'v2').identity.sha256,
      '95e04d0c4bad94ab206efa884666fd89777dbe4f7bd9945af1829037a85c6192'
    )
    results.push({ browser: name, version: browser.version(), ...result })
    console.log(
      `${name}: ${files.length} metadata vectors, File IO and unsupported v2 rejection passed without WebCrypto`
    )
  } finally {
    await browser.close()
  }
}
await writeFile(
  `${output}/results.json`,
  `${JSON.stringify(results, null, 2)}\n`
)
