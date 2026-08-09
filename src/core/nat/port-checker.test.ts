import { tick } from '@core/nat/__test__/utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { PortChecker } from './port-checker'

describe('PortChecker', () => {
  let fetcher: { calls: string[]; reply: (body: string, ok?: boolean) => void }
  let checker: PortChecker

  beforeEach(() => {
    fetcher = {
      calls: [],
      reply: () => {
        throw new Error('not set')
      },
    }
    checker = new PortChecker({
      fetcher: async (url) => {
        fetcher.calls.push(url)
        return new Promise((resolve) => {
          fetcher.reply = (body, ok = true) => resolve({ ok, body })
        })
      },
    })
  })

  it('rejects non-HTTPS endpoints', async () => {
    const r = await checker.checkPortReachable({
      endpoints: ['http://insecure.example.com/check'],
      externalIp: '203.0.113.42',
      port: 6881,
      timeoutMs: 100,
    })
    expect(r.ok).toBe(false)
  })

  it('returns Unknown when no endpoints configured', async () => {
    const r = await checker.checkPortReachable({
      endpoints: [],
      externalIp: '203.0.113.42',
      port: 6881,
      timeoutMs: 100,
    })
    expect(r.ok).toBe(false)
  })

  it('invokes fetcher with composed URL', async () => {
    const checkP = checker.checkPortReachable({
      endpoints: ['https://checker.example.com/check'],
      externalIp: '203.0.113.42',
      port: 6881,
      timeoutMs: 500,
    })
    await tick()
    fetcher.reply('reachable: true')
    const r = await checkP
    expect(fetcher.calls[0]).toContain('203.0.113.42')
    expect(fetcher.calls[0]).toContain('6881')
    expect(r.ok).toBe(true)
  })

  it('rejects more than MAX_ENDPOINTS', async () => {
    const many = Array(15).fill('https://checker.example.com/check')
    const r = await checker.checkPortReachable({
      endpoints: many,
      externalIp: '203.0.113.42',
      port: 6881,
      timeoutMs: 100,
    })
    expect(r.ok).toBe(false)
  })

  it('rejects HTTP endpoint even when HTTPS present earlier', async () => {
    const r = await checker.checkPortReachable({
      endpoints: [
        'https://ok.example.com/check',
        'http://bad.example.com/check',
      ],
      externalIp: '203.0.113.42',
      port: 6881,
      timeoutMs: 100,
    })
    expect(r.ok).toBe(false)
    expect(fetcher.calls).toHaveLength(0)
  })

  it('reports reachable=false when body contains negative keyword', async () => {
    const checkP = checker.checkPortReachable({
      endpoints: ['https://checker.example.com/check'],
      externalIp: '203.0.113.42',
      port: 6881,
      timeoutMs: 500,
    })
    await tick()
    fetcher.reply('not reachable')
    const r = await checkP
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.reachable).toBe(false)
  })
})
