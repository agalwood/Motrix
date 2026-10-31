# @motrix/torrent

An unpublished, host-neutral TypeScript metadata library. It performs no network
or filesystem IO and has no Node, Buffer, fetch, Streams or WebCrypto dependency.
SHA-1 and SHA-256 use `@noble/hashes`, including on insecure HTTP browser origins.
This is a metadata library, not a peer-wire protocol or download engine.

```ts
import { parseTorrent, parseMagnet } from '@motrix/torrent'

const metadata = parseTorrent(bytes) // Uint8Array, synchronous
switch (metadata.identity.kind) {
  case 'v1': console.log(metadata.identity.sha1); break
  case 'v2': console.log(metadata.identity.sha256); break
  case 'hybrid': console.log(metadata.identity.sha1, metadata.identity.sha256)
}
const piece = metadata.v1?.pieces.at(0) // borrowed 20-byte view
const magnet = parseMagnet('magnet:?xt=urn:btmh:1220' + 'ab'.repeat(32))
```

The workspace exports TypeScript sources for bundlers. `pnpm --dir packages/torrent
build` produces standalone ESM JavaScript and declarations in `dist/`; publication
export paths are prepared in `publishConfig`. The package is private and is not
published by the application release process. The only runtime dependency is
`@noble/hashes`. All exports are side-effect free and tree-shakeable.

## Parsing contract

- Bencode integers are `bigint`; file lengths and offsets retain their exact
  values. Applications must explicitly narrow them to an engine's numeric limits.
- Byte strings, file-tree keys, info bytes, and hash tables borrow the input.
  Keep the input and returned views immutable for the parsed object's lifetime.
  `infoRange` records the exact original half-open byte interval. Re-encoding is
  for creating new metadata, never for reconstructing an existing identity.
- Dictionaries have binary keys (`BDictionary`) without prototype-sensitive
  object properties. Unknown keys and attributes remain inspectable in the
  original dictionaries. Integers, byte lengths, duplicates, truncation and
  trailing bytes are validated. Canonical key sorting is required by default.
- `allowUnsortedKeys` explicitly admits historical v1 encodings while retaining
  their original hash. It never admits duplicate keys or invalid numbers. v2
  remains canonical even with this option. Unknown `meta version` values fail.
- Default budgets: 64 MiB input/output and byte strings, depth 64, one million
  nodes (including keys), and 128 integer digits. Callers can lower budgets;
  traversal depth cannot exceed 128. Encoding also enforces these budgets.
- v1 verifies piece count against concatenated file length. v2 validates file
  trees, piece-size constraints, roots and complete piece layers, including
  Merkle root verification with zero subtree padding. Work memory for this
  verification is logarithmic; piece tables are not eagerly expanded to hex.
- Hybrid metadata must describe the same files in the same order, with matching
  lengths, attributes, symlinks and piece alignment. Zero-byte files occupy no
  piece space. Tail padding is optional. This checks metadata consistency; it
  cannot prove that v1 and v2 hashes describe identical payload bytes without
  reading and hashing those payloads.
- Full `.torrent` input requires all necessary piece layers. Unlike libtorrent's
  metadata-only mode, missing layers are rejected. BEP 9 message exchange and
  partial metadata assembly are outside this package.
- Private status, announce tiers, webseeds, comments, creation information,
  padding and file attributes are retained. An explicit empty announce-list
  takes precedence over announce, per BEP 12. URLs are metadata only; callers
  own URL validation, tracker policy, network access and SSRF protection.
- Paths remain raw byte components. The library does not normalize, sanitize,
  flatten or write them. v1 paths are relative to the name root; v2 paths follow
  the file tree without automatically prepending name. Filesystem mapping must
  reject or explicitly map unsafe names and collisions for the target platform.
- Magnets support hexadecimal/Base32 btih, SHA-256 btmh (`1220` multihashes), both
  identities, dn, tr, ws, xs, as, x.pe, and BEP 53 inclusive selection ranges.
  Ranges are never expanded; unknown parameters are retained. Conflicting
  identities and malformed escaping are rejected. Limits are 64 Ki characters
  and 1024 parameters. Bare hashes can be handled with `normalizeBtih`.
- Object-as-torrent, 20-byte hash-as-torrent, stream-magnet, remote URL, Blob and
  filesystem overloads from parse-torrent are intentionally absent. Callers
  perform IO before passing Uint8Array bytes to the explicit parser.

## Motrix adapter

`src/shared/lib/engine-torrent.ts` is the current engine projection. It selects
v1 SHA-1 for v1/hybrid, rejects pure v2 and symlinks, checks numeric limits,
decodes paths without replacing invalid UTF-8, and retains component boundaries.
It rejects noncanonical info dictionaries because aria2 re-encodes info before
hashing; unsorted outer v1 fields are admitted when info itself is canonical.
Storage policy validates components before joining them. Uploaded torrent bytes
are never rewritten. Hybrid download and local verification currently use the
v1 swarm and SHA-1 piece table; v2 payload verification is not advertised.
The current aria2 path treats padding as physical files; local verification
checks those engine-visible files, including symlink and integrity checks.

## Verification

```sh
pnpm --dir packages/torrent typecheck
pnpm --dir packages/torrent build
pnpm --dir packages/torrent test
pnpm exec playwright install chromium firefox webkit
pnpm --dir packages/torrent test:browser
```

The root Vitest suite also runs these Node tests once. They include independent
libtorrent expectations, legal-v1 differential tests against test-only
parse-torrent 11.0.24, malformed inputs, deterministic roundtrip properties and
byte fuzzing. Browser checks run in Chromium, Firefox and WebKit on an intercepted
non-loopback HTTP origin without WebCrypto, including Motrix File IO and v2
admission. Results are written under `output/playwright/manual/torrent-core/`.
See [fixture provenance](test/fixtures/README.md) for versions and licenses.

Protocol references: [BEP 3](https://www.bittorrent.org/beps/bep_0003.html),
[BEP 9](https://www.bittorrent.org/beps/bep_0009.html),
[BEP 12](https://www.bittorrent.org/beps/bep_0012.html),
[BEP 19](https://www.bittorrent.org/beps/bep_0019.html),
[BEP 27](https://www.bittorrent.org/beps/bep_0027.html),
[BEP 47](https://www.bittorrent.org/beps/bep_0047.html),
[BEP 52](https://www.bittorrent.org/beps/bep_0052.html),
[BEP 53](https://www.bittorrent.org/beps/bep_0053.html).
