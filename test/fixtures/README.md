# Test metadata provenance

Only `.torrent` metadata is vendored; no books, movies or application payloads
are distributed. Files are unchanged except that libtorrent filename underscores
are written as hyphens to follow this repository's naming convention.

- `webtorrent/`: `webtorrent/webtorrent-fixtures` tag **v2.0.3**, commit
  `f0f6cef` (GitHub tag archive). `alice.torrent` identifies Lewis Carroll's
  public-domain _Alice's Adventures in Wonderland_. `numbers.torrent`,
  `lots-of-numbers.torrent` and `folder.torrent` identify the repository's
  synthetic numeric/plain-text test data. These small metadata files come from
  the MIT-licensed repository; its README additionally classifies content as
  Public Domain or Creative Commons. No CC movie fixtures or book payloads are
  copied. Copyright and MIT terms are retained in `webtorrent/LICENSE`.
- `libtorrent/`: `arvidn/libtorrent` tag **v2.0.11**, commit `9d7443f`.
  The small protocol test vectors are from `test/test_torrents/`. BSD-3-Clause
  terms and copyright are retained in `libtorrent/LICENSE`. Hash and size
  expectations are adapted from `test/test_torrent_info.cpp`; its additional
  contributor notices are retained in `../libtorrent.test.ts`.
- `../upstream.test.ts` adapts supported-input, single/multi-file, webseed and
  missing-name scenarios from `webtorrent/parse-torrent` **v11.0.24**, commit
  `201d579`. The MIT notice is retained in `../LICENSE.upstream`. The missing-name
  case explicitly asserts rejection, fixing the upstream catch-only assertion.
  Remote IO and obsolete overload scenarios are outside this package's API.

The libtorrent missing-piece-layers vector is deliberately rejected here:
this API accepts complete metainfo, while libtorrent also supports partial
metadata admission. Invalid filename bytes are retained rather than silently
sanitized; filesystem mapping is a separate application responsibility.

This corpus was extracted with the parser from Motrix commit
`4893edf3df8688e7669f8d19908dd68add8f0e61`. Application-specific fixtures and
admission checks remain in the Motrix repository.
