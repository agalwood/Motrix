import { describe, expect, it, vi } from 'vitest'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import { HandoffEndpointChangedError } from '@/background/handoff/guard'
import { type HandoffOps, runHandoff } from '@/background/handoff/runHandoff'
import { RemoteDataBoundaryConsentRequiredError } from '@/background/remote-submit-policy'
import type { TakeoverTarget } from '@/shared/takeover'

function target(over: Partial<TakeoverTarget> = {}): TakeoverTarget {
  return {
    url: 'https://cdn.example.com/f.zip',
    pageUrl: 'https://example.com',
    pageTitle: 'P',
    suggestedFilename: 'f.zip',
    mime: '',
    sizeBytes: 10,
    siteHint: 'example.com',
    origin: 'auto',
    ...over,
  }
}

function ops(over: Partial<HandoffOps> = {}): HandoffOps {
  return {
    assertCurrent: vi.fn(),
    getState: () => 'connected',
    connectWithLaunch: vi.fn(async () => {}),
    waitForConnected: vi.fn(async () => true),
    isPaired: vi.fn(async () => true),
    canAutoConnect: vi.fn(async () => true),
    isSensitive: () => false,
    confirmSensitive: vi.fn(async () => true),
    cancelNative: vi.fn(async () => {}),
    fallbackToBrowser: vi.fn(async () => {}),
    captureCookies: vi.fn(async () => []),
    buildHeaders: () => ({}),
    submit: vi.fn(async () => ({ taskId: 't1' })),
    notify: vi.fn(),
    nudgePair: vi.fn(async () => {}),
    ...over,
  }
}

describe('runHandoff', () => {
  it('does not replay or browser-fallback an ambiguous submit after cancellation', async () => {
    const o = ops({
      submit: vi.fn(async () => {
        throw new DownloadOutcomeUnknownError()
      }),
    })
    await runHandoff(target(), o)
    expect(o.cancelNative).toHaveBeenCalledOnce()
    expect(o.submit).toHaveBeenCalledOnce()
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
    expect(o.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'reminder' })
    )
  })

  it('keeps the native download when the endpoint changes during data preparation', async () => {
    let changed = false
    const o = ops({
      assertCurrent: () => {
        if (changed) throw new HandoffEndpointChangedError()
      },
      captureCookies: vi.fn(async () => {
        changed = true
        return []
      }),
    })
    await runHandoff(target(), o)
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
  })

  it('does not retry a remote consent rejection', async () => {
    const o = ops({
      submit: vi.fn(async () => {
        throw new RemoteDataBoundaryConsentRequiredError()
      }),
    })
    await runHandoff(target({ origin: 'context-menu' }), o)
    expect(o.submit).toHaveBeenCalledOnce()
    expect(o.waitForConnected).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).toHaveBeenCalledOnce()
  })
  it('connected + non-sensitive: cancels native then submits', async () => {
    const o = ops()
    await runHandoff(target(), o)
    expect(o.cancelNative).toHaveBeenCalledOnce()
    expect(o.submit).toHaveBeenCalledOnce()
  })

  it('unpaired: never cancels, nudges, leaves native download', async () => {
    const o = ops({
      getState: () => 'disconnected',
      isPaired: vi.fn(async () => false),
    })
    await runHandoff(target(), o)
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
    expect(o.nudgePair).toHaveBeenCalledOnce()
  })

  it('paired-disconnected, connect times out: never cancels, no submit', async () => {
    const o = ops({
      getState: () => 'disconnected',
      waitForConnected: vi.fn(async () => false),
    })
    await runHandoff(target(), o)
    expect(o.connectWithLaunch).toHaveBeenCalledOnce()
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('explicit HTTP(S) connect timeout starts the download in the browser', async () => {
    const o = ops({
      getState: () => 'disconnected',
      waitForConnected: vi.fn(async () => false),
    })

    await runHandoff(target({ origin: 'context-menu' }), o)

    expect(o.fallbackToBrowser).toHaveBeenCalledOnce()
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
    expect(o.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'reminder' })
    )
  })

  it('explicit HTTP(S) connect error also starts the browser fallback', async () => {
    const o = ops({
      getState: () => 'disconnected',
      connectWithLaunch: vi.fn(async () => {
        throw new Error('native host unavailable')
      }),
    })

    await runHandoff(target({ origin: 'context-menu' }), o)

    expect(o.waitForConnected).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).toHaveBeenCalledOnce()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('sensitive + decline: never cancels, never submits, leaves native download', async () => {
    const o = ops({
      isSensitive: () => true,
      confirmSensitive: vi.fn(async () => false),
    })
    await runHandoff(target(), o)
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('explicit sensitive HTTP(S) decline hands the download to the browser', async () => {
    const o = ops({
      isSensitive: () => true,
      confirmSensitive: vi.fn(async () => false),
    })

    await runHandoff(target({ origin: 'context-menu' }), o)

    expect(o.fallbackToBrowser).toHaveBeenCalledOnce()
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('sensitive + confirm: cancels and submits with EMPTY cookies', async () => {
    const captureCookies = vi.fn(async () => [
      {
        name: 'x',
        value: 'y',
        domain: 'd',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'unspecified' as const,
      },
    ])
    let submitted: DownloadSubmitParamsLike | undefined
    const o = ops({
      isSensitive: () => true,
      confirmSensitive: vi.fn(async () => true),
      captureCookies,
      submit: vi.fn(async (p) => {
        submitted = p
        return { taskId: 't' }
      }),
    })
    await runHandoff(target(), o)
    expect(o.cancelNative).toHaveBeenCalledOnce()
    expect(captureCookies).not.toHaveBeenCalled()
    expect(
      submitted?.selection.kind === 'direct'
        ? submitted.selection.primary.cookies
        : ['x']
    ).toEqual([])
  })

  it('submit rejects after commit: falls back to a browser download', async () => {
    const o = ops({
      submit: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await runHandoff(target(), o)
    expect(o.cancelNative).toHaveBeenCalledOnce()
    expect(o.submit).toHaveBeenCalledTimes(2)
    expect(o.fallbackToBrowser).toHaveBeenCalledOnce()
  })

  it('retries a lost submit response with the same idempotency key before fallback', async () => {
    const submit = vi
      .fn(async (_params: DownloadSubmitParamsLike) => ({
        taskId: 'recovered',
      }))
      .mockRejectedValueOnce(new Error('response lost'))
    const o = ops({ submit })

    await runHandoff(target(), o)

    expect(submit).toHaveBeenCalledTimes(2)
    const first = submit.mock.calls[0]?.[0]
    const second = submit.mock.calls[1]?.[0]
    expect(first?.idempotencyKey).toMatch(/^.{8,128}$/)
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey)
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
  })

  it('waits for a probe reconnect before retrying a transport failure', async () => {
    let state: ReturnType<HandoffOps['getState']> = 'connected'
    const waitForConnected = vi.fn(async () => {
      state = 'connected'
      return true
    })
    const submit = vi
      .fn(async () => ({ taskId: 'recovered' }))
      .mockImplementationOnce(async () => {
        state = 'disconnected'
        throw new Error('socket closed')
      })
    const o = ops({
      getState: () => state,
      waitForConnected,
      submit,
    })

    await runHandoff(target(), o)

    expect(waitForConnected).toHaveBeenCalledWith(8000)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
  })

  it('success notification failure never re-issues an already-submitted download', async () => {
    const o = ops({
      notify: vi.fn(() => {
        throw new Error('notification API unavailable')
      }),
    })

    await expect(runHandoff(target(), o)).resolves.toMatchObject({
      kind: 'accepted',
      taskId: 't1',
    })
    expect(o.submit).toHaveBeenCalledOnce()
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
  })

  it('fallback failure still attempts the error notification and propagates', async () => {
    const notify = vi.fn()
    const o = ops({
      notify,
      submit: vi.fn(async () => {
        throw new Error('submit failed')
      }),
      fallbackToBrowser: vi.fn(async () => {
        throw new Error('native fallback failed')
      }),
    })

    await expect(runHandoff(target(), o)).rejects.toThrow(
      'native fallback failed'
    )
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    )
  })

  it('cookie capture rejects before commit: leaves the native download intact', async () => {
    const o = ops({
      captureCookies: vi.fn(async () => {
        throw new Error('cookies unavailable')
      }),
    })

    await expect(runHandoff(target(), o)).rejects.toThrow('cookies unavailable')
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('explicit cookie-capture failure starts the browser fallback', async () => {
    const o = ops({
      captureCookies: vi.fn(async () => {
        throw new Error('cookies unavailable')
      }),
    })

    await expect(
      runHandoff(target({ origin: 'context-menu' }), o)
    ).resolves.toEqual({ kind: 'browser' })
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).toHaveBeenCalledOnce()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('header construction rejects before commit: leaves the native download intact', async () => {
    const o = ops({
      isSensitive: () => true,
      buildHeaders: () => {
        throw new Error('headers unavailable')
      },
    })

    await expect(runHandoff(target(), o)).rejects.toThrow('headers unavailable')
    expect(o.cancelNative).not.toHaveBeenCalled()
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
    expect(o.submit).not.toHaveBeenCalled()
  })

  it('explicit context-menu while unpaired drives pairing (connectWithLaunch), not just a nudge', async () => {
    const o = ops({
      getState: () => 'disconnected',
      isPaired: vi.fn(async () => false),
      waitForConnected: vi.fn(async () => false), // user has not paired yet
    })
    await runHandoff(target({ origin: 'context-menu' }), o)
    expect(o.connectWithLaunch).toHaveBeenCalledOnce()
    expect(o.nudgePair).not.toHaveBeenCalled()
  })

  it('auto origin while unpaired still nudges (unchanged)', async () => {
    const o = ops({
      getState: () => 'disconnected',
      isPaired: vi.fn(async () => false),
    })
    await runHandoff(target({ origin: 'auto' }), o) // target() default origin is 'auto'
    expect(o.nudgePair).toHaveBeenCalledOnce()
    expect(o.connectWithLaunch).not.toHaveBeenCalled()
  })

  it('tags handoff success as confirm and submit-failure as error', async () => {
    const okNotify = vi.fn()
    await runHandoff(target(), ops({ notify: okNotify }))
    expect(okNotify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'confirm' })
    )

    const failNotify = vi.fn()
    await runHandoff(
      target(),
      ops({
        notify: failNotify,
        submit: vi.fn(async () => {
          throw new Error('boom')
        }),
      })
    )
    expect(failNotify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    )
  })

  it('tags not-connected (unpaired auto) as reminder and connect-timeout as error', async () => {
    const reminderNotify = vi.fn()
    await runHandoff(
      target(),
      ops({
        getState: () => 'disconnected',
        isPaired: vi.fn(async () => false),
        notify: reminderNotify,
      })
    )
    expect(reminderNotify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'reminder' })
    )

    const errorNotify = vi.fn()
    await runHandoff(
      target(),
      ops({
        getState: () => 'disconnected',
        waitForConnected: vi.fn(async () => false),
        notify: errorNotify,
      })
    )
    expect(errorNotify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    )
  })

  it('magnet target: submits without capturing cookies or headers', async () => {
    const buildHeaders = vi.fn(() => ({ Referer: 'https://example.com' }))
    let submitted: DownloadSubmitParamsLike | undefined
    const o = ops({
      buildHeaders,
      submit: vi.fn(async (p) => {
        submitted = p
        return { taskId: 'm1' }
      }),
    })
    await runHandoff(
      target({ url: 'magnet:?xt=urn:btih:abc', origin: 'context-menu' }),
      o
    )
    expect(o.captureCookies).not.toHaveBeenCalled()
    expect(buildHeaders).not.toHaveBeenCalled()
    expect(o.submit).toHaveBeenCalledOnce()
    expect(submitted?.selection.kind).toBe('magnet')
  })

  it('magnet connect timeout never invokes browser-download fallback', async () => {
    const o = ops({
      getState: () => 'disconnected',
      waitForConnected: vi.fn(async () => false),
    })

    await runHandoff(
      target({ url: 'magnet:?xt=urn:btih:abc', origin: 'context-menu' }),
      o
    )

    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
    expect(o.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    )
  })

  it('magnet submit failure stays retryable instead of becoming a browser download', async () => {
    const o = ops({
      submit: vi.fn(async () => {
        throw new Error('submit failed')
      }),
    })

    await runHandoff(
      target({ url: 'magnet:?xt=urn:btih:abc', origin: 'context-menu' }),
      o
    )

    expect(o.submit).toHaveBeenCalledTimes(2)
    expect(o.fallbackToBrowser).not.toHaveBeenCalled()
    expect(o.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    )
  })
})

type DownloadSubmitParamsLike = import('@motrix/mdxp').DownloadSubmitParams
