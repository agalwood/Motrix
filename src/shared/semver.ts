// Semver precedence (semver.org §11), shared by both plugin update
// channels (community registry scan + builtin signed updater). Pure —
// src/shared/ allows no IO. Unparseable cores are unorderable (0), so
// callers never offer an update they cannot order; build metadata is
// ignored per spec.

interface ParsedSemver {
  core: number[]
  pre: string[]
}

const NUMERIC_RE = /^\d+$/

function parse(v: string): ParsedSemver {
  const plus = v.indexOf('+')
  const noBuild = plus === -1 ? v : v.slice(0, plus)
  const dash = noBuild.indexOf('-')
  const corePart = dash === -1 ? noBuild : noBuild.slice(0, dash)
  const prePart = dash === -1 ? '' : noBuild.slice(dash + 1)
  return {
    core: corePart
      .split('.')
      .map((n) => (NUMERIC_RE.test(n) ? Number.parseInt(n, 10) : Number.NaN)),
    pre: prePart ? prePart.split('.') : [],
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const ai = pa.core[i] ?? 0
    const bi = pb.core[i] ?? 0
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0
    if (ai !== bi) return ai > bi ? 1 : -1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // shorter prerelease set sorts lower
    if (y === undefined) return 1
    const nx = NUMERIC_RE.test(x) ? Number.parseInt(x, 10) : null
    const ny = NUMERIC_RE.test(y) ? Number.parseInt(y, 10) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx > ny ? 1 : -1
    } else if (nx !== null) {
      return -1 // numeric identifiers sort below alphanumeric
    } else if (ny !== null) {
      return 1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

export function semverGt(a: string, b: string): boolean {
  return compareSemver(a, b) > 0
}
