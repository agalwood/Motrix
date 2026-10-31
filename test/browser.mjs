import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, firefox, webkit } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}/output/playwright/manual/torrent-core`
await mkdir(output, { recursive: true })
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['dist/index.js'],
  bundle: true,
  format: 'iife',
  globalName: 'Torrent',
  platform: 'browser',
  write: false,
})
const files = await Promise.all(
  [
    'webtorrent/alice',
    'webtorrent/numbers',
    'webtorrent/lots-of-numbers',
    'webtorrent/folder',
    'libtorrent/v2',
    'libtorrent/v2-multipiece-file',
    'libtorrent/v2-only',
    'libtorrent/empty-files-1',
    'libtorrent/v2-symlinks',
  ].map(async (name) => ({
    name,
    bytes: [
      ...(await readFile(
        new URL(`./fixtures/${name}.torrent`, import.meta.url)
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
      const { parseTorrent, encode, decode, parseMagnet } = globalThis.Torrent
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
      const file = new File([seed], 'fixture.torrent')
      const fromFile = parseTorrent(new Uint8Array(await file.arrayBuffer()))
      if (fromFile.identity.sha1 !== hashes[0].identity.sha1)
        throw new Error('Caller-owned File IO changed identity')
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
        callerFileIo: true,
      }
    }, files)
    assert.equal(
      result.hashes.find((f) => f.name === 'libtorrent/v2-only').identity
        .sha256,
      '95e04d0c4bad94ab206efa884666fd89777dbe4f7bd9945af1829037a85c6192'
    )
    results.push({ browser: name, version: browser.version(), ...result })
    console.log(
      `${name}: ${files.length} metadata vectors and caller-owned File IO passed without WebCrypto`
    )
  } finally {
    await browser.close()
  }
}
await writeFile(
  `${output}/results.json`,
  `${JSON.stringify(results, null, 2)}\n`
)
