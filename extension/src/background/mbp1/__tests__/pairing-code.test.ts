import { describe, expect, it } from 'vitest'
import { normalizePairingCode } from '@/background/mbp1/pairing-code'

describe('normalizePairingCode (§7.1)', () => {
  it('normalizes confusables and grouping', () => {
    expect(normalizePairingCode('mtx7-k2q9')).toBe('MTX7K2Q9')
    expect(normalizePairingCode('OIL5 1234')).toBe('01151234') // O→0 I→1 L→1
  })

  it('normalizes both letter cases of O/I/L identically', () => {
    // Derived by hand from §7.1, independent of the implementation:
    // raw "oIlL-Oi78" -> strip "-" -> "oIlLOi78" (8 chars)
    //   -> uppercase   -> "OILLOI78"
    //   -> map O->0, I->1, L->1, each occurrence in order:
    //        O I L L O I 7 8
    //        0 1 1 1 0 1 7 8
    //   -> "01110178"
    expect(normalizePairingCode('oIlL-Oi78')).toBe('01110178')
    // Same six confusable letters, opposite case pairing per position,
    // must still fold to the identical result since case is normalized
    // before the O/I/L map is applied.
    expect(normalizePairingCode('OiLl-oI78')).toBe('01110178')
  })

  it('rejects wrong length and non-alphabet chars without throwing', () => {
    expect(normalizePairingCode('SHORT')).toBeNull()
    expect(normalizePairingCode('UUUUUUUU')).toBeNull() // U excluded from Crockford
  })

  it('rejects input that is too long after stripping separators', () => {
    expect(normalizePairingCode('123456789')).toBeNull()
    expect(normalizePairingCode('1234-5678-9')).toBeNull()
  })

  it('rejects empty input and pure separator input', () => {
    expect(normalizePairingCode('')).toBeNull()
    expect(normalizePairingCode('-- --')).toBeNull()
  })

  it('rejects non-alphabet punctuation/unicode without throwing', () => {
    expect(normalizePairingCode('MTX7@K2Q9')).toBeNull()
    expect(normalizePairingCode('MTX7😀K2Q9')).toBeNull()
  })

  it('rejects case-expanding input whose expansion is legal alphabet', () => {
    // The other rejection tests above all happen to die at the *alphabet*
    // check, so none of them can observe the length check at all. These
    // characters are chosen so the alphabet check cannot fire: each one is 1
    // character, uppercases to 2, and both halves of every expansion are legal
    // Crockford symbols. If the length check ran before `toUpperCase()`, each
    // of these would clear it at 8, clear the alphabet check, and be returned
    // as a 16-symbol string from a function that promises exactly 8.
    expect('ß'.toUpperCase()).toBe('SS') // guard the premise, not the code
    expect(normalizePairingCode('ßßßßßßßß')).toBeNull() // else -> 'SSSSSSSSSSSSSSSS'
    expect(normalizePairingCode('ﬁﬁﬁﬁﬁﬁﬁﬁ')).toBeNull() // else -> 'F1F1F1F1F1F1F1F1'
    // The corollary, pinned deliberately: the guarantee is on the *output*, so
    // a 4-character input that expands to exactly 8 legal symbols normalizes
    // rather than being rejected on its typed length. Line A's server does the
    // same, and interop requires this side agree byte for byte.
    expect(normalizePairingCode('ßßßß')).toBe('SSSSSSSS')
  })

  it('only strips ASCII hyphen and space, not other separators', () => {
    // If '_' were (incorrectly) stripped like '-', this would reduce to the
    // valid 8-symbol code "MTX72Q98". Since '_' must NOT be stripped, the
    // 9-character string survives with the wrong length and is rejected.
    expect(normalizePairingCode('MTX7_2Q98')).toBeNull()
  })
})
