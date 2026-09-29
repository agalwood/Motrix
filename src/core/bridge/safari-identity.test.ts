import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mintTicket } from './__tests__/mbp1-ticket'
import { Mbp1CredentialStore } from './credential-store'
import {
  createExtensionIdentityResolver,
  normalizeExtensionIdentity,
} from './extension-identity-resolver'
import { fromBase64Url } from './mbp1/canonical'
import { TicketReplayCache, verifyNmTicket } from './mbp1/ticket-verify'

const uuid = '12345678-90ab-cdef-1234-567890abcdef'
const origin = `safari-web-extension://${uuid}`
const bundleId = 'app.motrix.safari.extension'
const resolver = createExtensionIdentityResolver({
  environment: 'production',
  developmentEntries: [],
})
const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function identity(claim = bundleId) {
  const result = normalizeExtensionIdentity({
    browser: 'safari',
    verifiedOrigin: origin,
    claimedExtensionId: claim,
  })
  if (!result.ok) throw new Error('Fixture rejected')
  return result.identity
}

describe('Safari signed identity contract', () => {
  it('keeps the installation UUID separate from the claimed bundle identity', () => {
    expect(identity()).toEqual({
      browser: 'safari',
      originHost: uuid,
      verifiedExtensionId: null,
    })
    expect(resolver.resolve(identity(), { kind: 'none' })).toMatchObject({
      identity: 'unverified',
      provenExtensionId: null,
    })
    expect(
      resolver.resolve(identity('someone.else'), { kind: 'none' })
    ).toMatchObject({ identity: 'unverified' })
  })
  it('requires an attested allowlisted bundle ID for official identity', () => {
    expect(
      resolver.resolve(identity(), {
        kind: 'verified-nm-ticket',
        callerId: bundleId,
      })
    ).toMatchObject({
      identity: 'official',
      evidence: 'verified-nm-ticket',
      provenExtensionId: bundleId,
    })
    expect(
      resolver.resolve(identity(), {
        kind: 'verified-nm-ticket',
        callerId: 'example.other.extension',
      })
    ).toMatchObject({ identity: 'attested-non-official' })
  })
  it.each([
    'null',
    'https://example.com',
    `safari-web-extension://${bundleId}`,
    `safari-web-extension://${uuid.toUpperCase()}`,
    `${origin}/`,
    `${origin}:80`,
    `${origin}:`,
    `${origin}?`,
    `${origin}#`,
    `${origin}/path`,
    `safari-web-extension://user@${uuid}`,
    `${origin} `,
  ])('rejects noncanonical or nonextension origins: %s', (verifiedOrigin) => {
    expect(
      normalizeExtensionIdentity({
        browser: 'safari',
        verifiedOrigin,
        claimedExtensionId: bundleId,
      }).ok
    ).toBe(false)
  })
  it('verifies Safari ticket MAC, browser, caller and one-shot replay', () => {
    const material = mintTicket({
      localToken: 'test-only-local-token',
      serverGeneration: 'test-generation',
      browser: 'safari',
      callerId: bundleId,
    })
    const context = {
      localToken: 'test-only-local-token',
      serverGeneration: 'test-generation',
      nowMs: Date.now(),
      helloBrowser: 'safari',
      helloClaimedExtensionId: bundleId,
      helloTicketBindingKey: fromBase64Url(material.bindingKeyB64),
      replay: new TicketReplayCache(),
    }
    expect(
      verifyNmTicket(material.wire, { ...context, helloBrowser: 'firefox' })
    ).toMatchObject({ kind: 'abort', reason: 'browserMismatch' })
    expect(
      verifyNmTicket(material.wire, {
        ...context,
        helloClaimedExtensionId: 'example.other.extension',
      })
    ).toMatchObject({ kind: 'abort', reason: 'callerIdMismatch' })
    expect(
      verifyNmTicket(
        { ...material.wire, callerId: 'example.other.extension' },
        context
      )
    ).toMatchObject({ kind: 'abort', reason: 'macMismatch' })
    expect(verifyNmTicket(material.wire, context)).toMatchObject({
      kind: 'attested',
      callerId: bundleId,
    })
    expect(verifyNmTicket(material.wire, context)).toMatchObject({
      kind: 'abort',
      reason: 'replayed',
    })
  })
  it('persists Safari credentials under their origin without replacing a Firefox principal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motrix-safari-contract-'))
    folders.push(dir)
    const file = join(dir, 'credentials.json')
    const store = await Mbp1CredentialStore.load(file)
    const safari = {
      browser: 'safari' as const,
      verifiedOrigin: origin,
      clientInstallationId: 'install-a',
    }
    const firefox = {
      browser: 'firefox' as const,
      verifiedOrigin: `moz-extension://${uuid}`,
      clientInstallationId: 'install-a',
    }
    const first = await store.offerProvisional(safari, 'official')
    const other = await store.offerProvisional(firefox, 'unverified')
    expect(first.credentialId).not.toBe(other.credentialId)
    const reopened = await Mbp1CredentialStore.load(file)
    expect(
      (await reopened.offerProvisional(safari, 'official')).credentialId
    ).toBe(first.credentialId)
    expect(
      (await reopened.offerProvisional(firefox, 'unverified')).credentialId
    ).toBe(other.credentialId)
  })
})
