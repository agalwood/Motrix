import { describe, expect, it } from 'vitest'
import { redactApplicationLogArguments, redactLogFields } from './log-redact'

describe('redactLogFields', () => {
  describe('application profile', () => {
    it('retains safe create diagnostics while removing request credentials', () => {
      const out = redactLogFields(
        {
          method: 'createDownload',
          params: {
            gid: '0123456789abcdef',
            uris: [
              'https://user:pass@example.com/file.zip?token=url-secret#part',
            ],
            saveDir: '/Users/alice/Downloads',
            filename: 'file.zip.motrix',
            connections: 16,
            headers: {
              Authorization: 'Bearer auth-secret',
              Cookie: 'session=cookie-secret',
            },
            proxy: 'http://user:proxy-secret@proxy.example:8080/private',
            extraEngineOptions: {
              referer: 'https://origin.example/watch?token=referer-secret',
              'load-cookies': '/tmp/cookie-jar-secret.txt',
              'select-file': '1,3',
              'unknown-option': 'unknown-secret',
            },
          },
        },
        { profile: 'application' }
      )

      expect(out).toEqual({
        method: 'createDownload',
        params: {
          gid: '0123456789abcdef',
          uris: ['https://example.com/file.zip'],
          saveDir: '/Users/alice/Downloads',
          filename: 'file.zip.motrix',
          connections: 16,
          headers: ['Authorization', 'Cookie'],
          proxy: 'http://proxy.example:8080',
          extraEngineOptions: {
            referer: 'https://origin.example/watch',
            'load-cookies': '[redacted-path]',
            'select-file': '1,3',
            'unknown-option': '[redacted]',
          },
        },
      })
      const serialized = JSON.stringify(out)
      for (const secret of [
        'url-secret',
        'auth-secret',
        'cookie-secret',
        'proxy-secret',
        'referer-secret',
        'cookie-jar-secret',
        'unknown-secret',
      ]) {
        expect(serialized).not.toContain(secret)
      }
    })

    it('sanitizes URL collections and opaque URIs', () => {
      const out = redactLogFields(
        {
          rewrittenUris: [
            'https://cdn.example/file?signature=secret',
            'magnet:?xt=urn:btih:secret-info-hash&dn=private-name',
          ],
        },
        { profile: 'application' }
      )
      expect(out.rewrittenUris).toEqual([
        'https://cdn.example/file',
        'magnet:<redacted>',
      ])
    })

    it('preserves short collection provenance but bounds locations', () => {
      const out = redactLogFields(
        {
          uris: 'plugin-rewriter',
          urls: 3,
          sourceUrl: `https://example.com/${'x'.repeat(70_000)}`,
          proxy: `http://${'y'.repeat(70_000)}.example`,
        },
        { profile: 'application' }
      )

      expect(out).toEqual({
        uris: 'plugin-rewriter',
        urls: 3,
        sourceUrl: '[unparseable-url]',
        proxy: '[unparseable-proxy]',
      })
      expect(redactLogFields(out, { profile: 'application' })).toEqual(out)
    })

    it('fails closed for object values in URL collections and storage keys', () => {
      const out = redactLogFields(
        {
          uris: { token: 'uri-object-secret' },
          storageKey: { token: 'storage-object-secret' },
        },
        { profile: 'application' }
      )

      expect(out).toEqual({
        uris: '[unparseable-url]',
        storageKey: '[redacted]',
      })
      expect(JSON.stringify(out)).not.toContain('object-secret')
    })

    it('redacts exact credential keys without hiding diagnostic metadata', () => {
      const out = redactLogFields(
        {
          token: 'secret',
          api_key: 'secret',
          authToken: 'secret',
          clientSecret: 'secret',
          credentials: { password: 'secret' },
          privateKey: 'secret',
          tokenCount: 2,
          hasCookie: true,
          secretFields: ['apiKey'],
        },
        { profile: 'application' }
      )
      expect(out).toEqual({
        token: '[redacted]',
        api_key: '[redacted]',
        authToken: '[redacted]',
        clientSecret: '[redacted]',
        credentials: '[redacted]',
        privateKey: '[redacted]',
        tokenCount: 2,
        hasCookie: true,
        secretFields: ['apiKey'],
      })
    })

    it('redacts MBP1 secrets but keeps its public and diagnostic fields', () => {
      const out = redactLogFields(
        {
          mutualKeyB64: 'secret',
          pairNonce: 'secret',
          nmTicket: 'secret',
          // Public by construction: `ticketBindingKey` travels in cleartext in
          // pairHello and is bound into the transcript AAD, and `sessionKey` is
          // the `${browser}:${extensionId}` session identifier. Redacting
          // either would cost diagnosability and protect nothing.
          ticketBindingKey: 'AAAA',
          sessionKey: 'chromium:abcdef',
        },
        { profile: 'application' }
      )
      expect(out).toEqual({
        mutualKeyB64: '[redacted]',
        pairNonce: '[redacted]',
        nmTicket: '[redacted]',
        ticketBindingKey: 'AAAA',
        sessionKey: 'chromium:abcdef',
      })
    })

    it('omits body and storage values even when they are nullish', () => {
      const out = redactLogFields(
        { body: null, storageValue: undefined, status: 'ready' },
        { profile: 'application' }
      )
      expect(out).toEqual({ status: 'ready' })
    })

    it('keeps only syntactically valid header names', () => {
      const out = redactLogFields(
        {
          headers: [
            'Bearer malformed-header-secret',
            'Authorization: Bearer auth-secret',
            { name: 'Cookie', value: 'cookie-secret' },
            { name: 'invalid header', value: 'other-secret' },
          ],
        },
        { profile: 'application' }
      )

      expect(out.headers).toEqual(['Authorization', 'Cookie'])
      expect(JSON.stringify(out)).not.toContain('secret')
    })

    it('preserves proxy presence metadata', () => {
      const out = redactLogFields(
        {
          proxy: true,
          nested: { proxy: false },
          unset: { proxy: undefined },
          extraEngineOptions: undefined,
        },
        { profile: 'application' }
      )
      expect(out).toEqual({
        proxy: true,
        nested: { proxy: false },
        unset: { proxy: undefined },
        extraEngineOptions: undefined,
      })
    })

    it('fails closed when a safe engine option has an unexpected object', () => {
      const out = redactLogFields(
        {
          extraEngineOptions: {
            'select-file': { token: 'option-object-secret' },
            'seed-ratio': 1.5,
          },
        },
        { profile: 'application' }
      )

      expect(out.extraEngineOptions).toEqual({
        'select-file': '[redacted]',
        'seed-ratio': 1.5,
      })
      expect(JSON.stringify(out)).not.toContain('option-object-secret')
    })

    it('summarizes binary values instead of expanding their contents', () => {
      const out = redactLogFields(
        { bytes: new Uint8Array([1, 2, 3]) },
        { profile: 'application' }
      )
      expect(out.bytes).toBe('[binary:3 bytes]')
    })

    it('keeps error diagnostics while redacting structured error fields', () => {
      const cause = Object.assign(new Error('upstream failed'), {
        token: 'cause-secret',
      })
      const error = Object.assign(new Error('connection failed', { cause }), {
        code: 'ECONNRESET',
        token: 'error-secret',
      })
      const out = redactLogFields({ err: error }, { profile: 'application' })
      const redactedError = out.err as Error & Record<string, unknown>

      expect(redactedError).toBeInstanceOf(Error)
      expect(redactedError.name).toBe('Error')
      expect(redactedError.message).toBe('connection failed')
      expect(redactedError.stack).toContain('connection failed')
      expect(redactedError.code).toBe('ECONNRESET')
      expect(redactedError.token).toBe('[redacted]')
      const redactedCause = redactedError.cause as Error &
        Record<string, unknown>
      expect(redactedCause).toBeInstanceOf(Error)
      expect(redactedCause.message).toBe('upstream failed')
      expect(redactedCause.token).toBe('[redacted]')
      const serialized = JSON.stringify(redactedError)
      expect(serialized).toContain('connection failed')
      expect(serialized).toContain('ECONNRESET')
      expect(serialized).not.toContain('error-secret')
      expect(serialized).not.toContain('cause-secret')
    })

    it('retains a late enumerable Error cause beyond the width budget', () => {
      const error = new Error('wide failure') as Error & Record<string, unknown>
      for (let index = 0; index < 300; index += 1) {
        error[`field${index}`] = index
      }
      error.cause = Object.assign(new Error('root failure'), {
        token: 'late-cause-secret',
      })

      const out = redactLogFields({ err: error }, { profile: 'application' })
      const redactedError = out.err as Error & Record<string, unknown>
      const redactedCause = redactedError.cause as Error &
        Record<string, unknown>

      expect(redactedError.redactionTruncatedFields).toBe(46)
      expect(redactedCause.message).toBe('root failure')
      expect(redactedCause.token).toBe('[redacted]')
      expect(JSON.stringify(redactedError)).not.toContain('late-cause-secret')
    })

    it('handles circular values and hostile getters without throwing', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      Object.defineProperty(circular, 'hostile', {
        enumerable: true,
        get() {
          throw new Error('getter secret')
        },
      })

      const out = redactLogFields(circular, { profile: 'application' })
      expect(out.self).toBe('[circular]')
      expect(out.hostile).toBe('[unreadable]')
    })

    it('fails closed when a structured log object cannot be inspected', () => {
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('proxy secret')
          },
        }
      )
      expect(redactApplicationLogArguments([hostile, 'message'])).toEqual([
        { redactionFailed: true },
        'message',
      ])
    })

    it('blocks custom serialization and unknown object instances', () => {
      class SecretBox {
        password = 'class-secret'
      }
      const out = redactLogFields(
        {
          customSerializer: {
            visible: 'safe',
            toJSON: () => ({ token: 'serializer-secret' }),
          },
          secretBox: new SecretBox(),
        },
        { profile: 'application' }
      )

      expect(out).toEqual({
        customSerializer: {
          visible: 'safe',
          toJSON: '[function]',
        },
        secretBox: '[redacted-object]',
      })
      expect(JSON.stringify(out)).not.toContain('serializer-secret')
      expect(JSON.stringify(out)).not.toContain('class-secret')
    })

    it('renames root logger control fields without changing nested fields', () => {
      const out = redactLogFields(
        {
          level: 99,
          time: 0,
          msg: 'forged message',
          pid: 1,
          hostname: 'attacker',
          module: 'forged-module',
          name: 'resolved-file',
          timestamp: 123,
          ts: 2,
          nested: { level: 10, msg: 'nested diagnostic' },
        },
        { profile: 'application' }
      )

      expect(out).toEqual({
        fieldLevel: 99,
        fieldTime: 0,
        fieldMsg: 'forged message',
        fieldPid: 1,
        fieldHostname: 'attacker',
        fieldModule: 'forged-module',
        name: 'resolved-file',
        timestamp: 123,
        ts: 2,
        nested: { level: 10, msg: 'nested diagnostic' },
      })
    })

    it('preserves colliding diagnostic fields under deterministic suffixes', () => {
      const out = redactLogFields(
        {
          level: 99,
          fieldLevel: 'existing diagnostic',
          fieldLevel2: 'second diagnostic',
        },
        { profile: 'application' }
      )

      expect(out).toEqual({
        fieldLevel: 99,
        fieldLevel2: 'existing diagnostic',
        fieldLevel22: 'second diagnostic',
      })
      expect(redactLogFields(out, { profile: 'application' })).toEqual(out)
    })

    it('treats __proto__ as data instead of mutating the output prototype', () => {
      const input: Record<string, unknown> = { status: 'safe' }
      Object.defineProperty(input, '__proto__', {
        enumerable: true,
        value: { token: 'prototype-secret' },
      })

      const out = redactLogFields(input, { profile: 'application' })

      expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
      expect(Object.hasOwn(out, '__proto__')).toBe(true)
      expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({
        token: '[redacted]',
      })
      expect(JSON.stringify(out)).not.toContain('prototype-secret')
    })

    it('bounds structured strings, arrays, and record width idempotently', () => {
      const wide = Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`field${index}`, index])
      )
      const out = redactLogFields(
        {
          detail: 'x'.repeat(20_000),
          items: Array.from({ length: 300 }, (_, index) => index),
          wide,
        },
        { profile: 'application' }
      )

      expect((out.detail as string).length).toBeLessThanOrEqual(16 * 1024)
      expect(out.detail).toContain('[truncated:')
      expect(out.items).toHaveLength(256)
      expect((out.items as unknown[]).at(-1)).toBe('[truncated:45 items]')
      expect(Object.keys(out.wide as Record<string, unknown>)).toHaveLength(256)
      expect(
        (out.wide as Record<string, unknown>).redactionTruncatedFields
      ).toBe(45)
      expect(redactLogFields(out, { profile: 'application' })).toEqual(out)
    })

    it('replaces oversized field names without reading their values', () => {
      const oversizedKey = `credential-${'secret'.repeat(100)}`
      const input: Record<string, unknown> = { status: 'safe' }
      Object.defineProperty(input, oversizedKey, {
        enumerable: true,
        get() {
          throw new Error('oversized-value-secret')
        },
      })

      const out = redactLogFields(input, { profile: 'application' })

      expect(out).toEqual({
        status: 'safe',
        fieldKeyTruncated1: '[redacted]',
      })
      const serialized = JSON.stringify(out)
      expect(serialized).not.toContain(oversizedKey)
      expect(serialized).not.toContain('oversized-value-secret')
    })

    it('normalizes non-JSON bigint and symbol values', () => {
      const out = redactLogFields(
        { bytesRead: 42n, marker: Symbol('diagnostic') },
        { profile: 'application' }
      )
      expect(out).toEqual({
        bytesRead: '42n',
        marker: '[symbol:diagnostic]',
      })
      expect(() => JSON.stringify(out)).not.toThrow()
    })

    it('normalizes unusual primitive and function formatting arguments', () => {
      const out = redactApplicationLogArguments([
        'values %s %s %s',
        42n,
        Symbol('diagnostic'),
        () => 'function-secret',
      ])

      expect(out).toEqual([
        'values %s %s %s',
        '42n',
        '[symbol:diagnostic]',
        '[function]',
      ])
      expect(JSON.stringify(out)).not.toContain('function-secret')
    })

    it('does not invoke an overridden Date serializer', () => {
      const date = new Date('2026-08-21T00:00:00.000Z')
      Object.defineProperty(date, 'toJSON', {
        value: () => ({ token: 'date-serializer-secret' }),
      })

      const out = redactApplicationLogArguments(['date %j', date])

      expect(out).toEqual(['date %j', '2026-08-21T00:00:00.000Z'])
      expect(JSON.stringify(out)).not.toContain('date-serializer-secret')
    })

    it('is immutable and idempotent', () => {
      const input = {
        url: 'https://a.example/file?q=secret',
        headers: { Cookie: 'secret' },
        nested: { password: 'secret' },
      }
      const snapshot = structuredClone(input)
      const once = redactLogFields(input, { profile: 'application' })
      const twice = redactLogFields(once, { profile: 'application' })

      expect(input).toEqual(snapshot)
      expect(twice).toEqual(once)
    })
  })

  describe('plugin profile', () => {
    const redactPlugin = (fields: Record<string, unknown>, verbose = false) =>
      redactLogFields(fields, { profile: 'plugin', verbose })

    it('strips query strings and fragments from URLs', () => {
      const out = redactPlugin({
        url: 'https://api.example.com/v1/data?token=abc123&user=42#frag',
      })
      expect(out.url).toBe('https://api.example.com/v1/data')
    })

    it('preserves URL origin and pathname without query data', () => {
      const out = redactPlugin({ url: 'https://api.example.com/v1/data' })
      expect(out.url).toBe('https://api.example.com/v1/data')
    })

    it('uses a safe sentinel when a URL is not parseable', () => {
      const out = redactPlugin({ url: 'not-a-url' })
      expect(out.url).toBe('[unparseable-url]')
    })

    it('redacts nested URLs', () => {
      const out = redactPlugin({
        request: { url: 'https://api.example.com/?secret=xyz' },
      })
      expect((out.request as { url: string }).url).toBe(
        'https://api.example.com/'
      )
    })

    it('drops top-level and nested headers', () => {
      const out = redactPlugin({
        headers: { authorization: 'Bearer xxx' },
        request: { headers: { x: 1 }, url: 'https://a/b' },
        otherKey: 'kept',
      })
      expect('headers' in out).toBe(false)
      expect(out.otherKey).toBe('kept')
      const request = out.request as { headers?: unknown; url: string }
      expect(request.headers).toBeUndefined()
      expect(request.url).toBe('https://a/b')
    })

    it('drops body and storage values', () => {
      const out = redactPlugin({
        body: 'username=alice&password=hunter2',
        storageValue: 'secret',
      })
      expect('body' in out).toBe(false)
      expect('storageValue' in out).toBe(false)
    })

    it('reduces plugin paths to basenames on Unix and Windows', () => {
      const out = redactPlugin({
        path: '/Users/alice/Downloads/secret-document.pdf',
        filePath: 'C:\\Users\\alice\\data\\foo.txt',
        nested: { path: '/var/x/y/z.mp4' },
      })
      expect(out.path).toBe('secret-document.pdf')
      expect(out.filePath).toBe('foo.txt')
      expect((out.nested as { path: string }).path).toBe('z.mp4')
    })

    it('truncates long storage keys', () => {
      const out = redactPlugin({ storageKey: 'a'.repeat(50) })
      expect(out.storageKey).toBe(`${'a'.repeat(32)}…`)
    })

    it('keeps verbose values while protecting root logger control fields', () => {
      const input = {
        url: 'https://api.example.com/v1/data?token=abc',
        headers: { authorization: 'Bearer xxx' },
        body: 'payload',
        path: '/etc/passwd',
        storageKey: 'k'.repeat(50),
        storageValue: 'v',
        level: 99,
        msg: 'forged',
      }
      expect(redactPlugin(input, true)).toEqual({
        url: input.url,
        headers: input.headers,
        body: input.body,
        path: input.path,
        storageKey: input.storageKey,
        storageValue: input.storageValue,
        fieldLevel: 99,
        fieldMsg: 'forged',
      })
    })

    it('keeps verbose secrets but still blocks structural attacks', () => {
      const circular: Record<string, unknown> = { token: 'raw-secret' }
      circular.self = circular
      const out = redactPlugin(
        {
          nested: {
            token: 'raw-secret',
            toJSON: () => ({ token: 'serializer-secret' }),
          },
          circular,
          items: Array.from({ length: 300 }, (_, index) => index),
        },
        true
      )

      expect(out.nested).toEqual({
        token: 'raw-secret',
        toJSON: '[function]',
      })
      expect((out.circular as Record<string, unknown>).self).toBe('[circular]')
      expect(out.items).toHaveLength(256)
      expect(JSON.stringify(out)).toContain('raw-secret')
      expect(JSON.stringify(out)).not.toContain('serializer-secret')
    })
  })
})
