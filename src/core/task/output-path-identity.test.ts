// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { withBtOutputAdmission } from './bt-duplicate-policy'
import { outputPathIdentity } from './output-path-identity'

it('serializes admissions through a symlink before either output exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bt-output-alias-'))
  try {
    await mkdir(path.join(root, 'real'))
    await symlink(path.join(root, 'real'), path.join(root, 'alias'), 'junction')
    expect(outputPathIdentity(path.join(root, 'real', 'new', 'output'))).toBe(
      outputPathIdentity(path.join(root, 'alias', 'new', 'output'))
    )
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const order: number[] = []
    const first = withBtOutputAdmission(path.join(root, 'real'), async () => {
      order.push(1)
      entered.resolve()
      await release.promise
      order.push(2)
    })
    await entered.promise
    const second = withBtOutputAdmission(path.join(root, 'alias'), async () => {
      order.push(3)
    })
    await Promise.resolve()
    expect(order).toEqual([1])
    release.resolve()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2, 3])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
