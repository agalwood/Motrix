import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { prepareFlatpakNodeLock } from '../../scripts/prepare-flatpak-node-lock.mjs'

const bootstrap = `lockfileVersion: '9.0'
packages:
  pnpm@12.4.1:
    resolution: {integrity: sha512-bootstrap}
`
const application = `lockfileVersion: '9.0'
packages:
  react@19.3.0:
    resolution: {integrity: sha512-application}
`

describe('prepareFlatpakNodeLock', () => {
  it('retains both bootstrap and application integrity metadata', () => {
    expect(
      load(prepareFlatpakNodeLock(`${bootstrap}---\n${application}`))
    ).toEqual({
      lockfileVersion: '9.0',
      packages: {
        'pnpm@12.4.1': { resolution: { integrity: 'sha512-bootstrap' } },
        'react@19.3.0': { resolution: { integrity: 'sha512-application' } },
      },
    })
  })

  it('accepts legacy single-document locks and identical shared sources', () => {
    expect(prepareFlatpakNodeLock(bootstrap)).toBe(
      prepareFlatpakNodeLock(`${bootstrap}---\n${bootstrap}`)
    )
  })

  it('fails closed on conflicting integrity metadata or unknown formats', () => {
    expect(() =>
      prepareFlatpakNodeLock(
        `${bootstrap}---\n${bootstrap.replace('sha512-bootstrap', 'sha512-other')}`
      )
    ).toThrow('Conflicting pnpm source metadata: pnpm@12.4.1')
    expect(() => prepareFlatpakNodeLock('')).toThrow('Empty pnpm lockfile')
    expect(() => prepareFlatpakNodeLock("lockfileVersion: '10.0'\n")).toThrow(
      'requires pnpm lockfile v9'
    )
    expect(() => prepareFlatpakNodeLock("lockfileVersion: '9.0'\n")).toThrow(
      'missing its packages table'
    )
  })
})
