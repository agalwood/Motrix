import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { verifyFlatpakPackaging } from '../../scripts/verify-flatpak-packaging.mjs'

describe('Flatpak packaging contract', () => {
  it('keeps source, architecture, offline, and runtime paths aligned', async () => {
    await expect(verifyFlatpakPackaging(process.cwd())).resolves.toMatchObject({
      modules: 4,
      builtinSources: 6,
      brokerCommand: 'motrix-native-host-broker',
      electronPackageVerification: true,
      privateProtocolVersion: 1,
    })
  })
})
