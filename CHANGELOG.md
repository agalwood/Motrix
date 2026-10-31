# Changelog

## 0.1.1

- Bound dictionary/path indexing by entry references rather than expanded hex
  strings, and avoid rebuilding every ancestor prefix of a v1 file path.
- Preserve advisory and unknown hybrid file attributes without treating their
  differences as content-layout conflicts; keep symlink and padding checks.
- Check v2 piece-length powers of two with exact integer arithmetic.
- Add constrained-heap, binary-key, hybrid-attribute and large-integer regressions.

## 0.1.0

- Extract the metadata core from Motrix into an independently tested ESM package.
- Parse v1, v2 and hybrid metadata with typed identities, exact info ranges,
  compact piece tables, Merkle piece-layer verification and layout validation.
- Provide bounded binary bencode and btih/btmh magnets with file selections.
- Support modern browsers, Node and Electron without IO or WebCrypto fallbacks.
