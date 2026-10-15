import { describe, expect, it } from 'vitest'
import { serverFormSchema, takeoverFormSchema } from '@/options/tabs/schemas'

describe('serverFormSchema', () => {
  it('requires a server name', () => {
    expect(
      serverFormSchema.safeParse({
        name: '  ',
        url: 'wss://motrix.example',
      }).success
    ).toBe(false)
  })

  it('requires a server url', () => {
    expect(
      serverFormSchema.safeParse({ name: 'Home', url: '  ' }).success
    ).toBe(false)
  })

  it('accepts strict WS and WSS server addresses', () => {
    expect(
      serverFormSchema.safeParse({
        name: 'Home',
        url: 'wss://motrix.example/bridge/',
      }).success
    ).toBe(true)
    expect(
      serverFormSchema.safeParse({
        name: 'NAS',
        url: 'ws://nas.local:8888/bridge/',
      }).success
    ).toBe(true)
  })

  it.each([
    'http://motrix.example',
    'wss://user:secret@motrix.example',
    'wss://motrix.example?token=secret',
    'wss://motrix.example#fragment',
    ' wss://motrix.example',
    'wss://motrix.example ',
    'wss://motrix.example/%252fadmin',
    'wss:\\motrix.example\\bridge',
  ])('rejects ambiguous server URL %s', (url) => {
    const r = serverFormSchema.safeParse({ name: 'Home', url })
    expect(r.success).toBe(false)
  })
})

describe('takeoverFormSchema', () => {
  it('accepts empty thresholdMB', () => {
    expect(
      takeoverFormSchema.safeParse({
        downloadMode: 'direct',
        enabled: false,
        thresholdMB: '',
        unknownSizeAction: 'chrome',
        denylist: '',
      }).success
    ).toBe(true)
  })
  it('rejects negative thresholdMB', () => {
    expect(
      takeoverFormSchema.safeParse({
        downloadMode: 'direct',
        enabled: true,
        thresholdMB: '-3',
        unknownSizeAction: 'chrome',
        denylist: '',
      }).success
    ).toBe(false)
  })
})
