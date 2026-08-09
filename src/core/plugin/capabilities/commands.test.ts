import { describe, expect, it, vi } from 'vitest'
import {
  CommandsCapabilityHost,
  CommandsError,
  type CrossPluginInvoker,
} from './commands'

describe('CommandsCapabilityHost', () => {
  // -------------------------------------------------------------------------
  // 1. register succeeds within own namespace
  // -------------------------------------------------------------------------
  it('register within own namespace succeeds and has() returns true', () => {
    const host = new CommandsCapabilityHost()
    host.register('alice.demo', 'alice.demo.greet', () => 'hello')
    expect(host.has('alice.demo.greet')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 2. register outside own namespace throws id_out_of_namespace
  // -------------------------------------------------------------------------
  it('register with foreign namespace throws id_out_of_namespace', () => {
    const host = new CommandsCapabilityHost()
    expect(() => host.register('alice.demo', 'bob.demo.x', () => null)).toThrow(
      expect.objectContaining({ code: 'plugin.commands.id_out_of_namespace' })
    )
  })

  // -------------------------------------------------------------------------
  // 3. namespace prefix must end at a dot — alice.demoX.y is rejected
  // -------------------------------------------------------------------------
  it('register rejects a commandId that shares prefix chars but not a full dot segment', () => {
    const host = new CommandsCapabilityHost()
    // 'alice.demoX.y' starts with 'alice.demo' but NOT 'alice.demo.'
    expect(() =>
      host.register('alice.demo', 'alice.demoX.y', () => null)
    ).toThrow(
      expect.objectContaining({ code: 'plugin.commands.id_out_of_namespace' })
    )
  })

  // -------------------------------------------------------------------------
  // 4. execute own-namespace returns handler return value
  // -------------------------------------------------------------------------
  it('execute dispatches to handler and returns its result', async () => {
    const host = new CommandsCapabilityHost()
    host.register(
      'alice.demo',
      'alice.demo.greet',
      (args) => `hello, ${(args as { name: string }).name}`
    )
    const result = await host.execute('alice.demo', 'alice.demo.greet', {
      name: 'Bob',
    })
    expect(result).toBe('hello, Bob')
  })

  // -------------------------------------------------------------------------
  // 5. execute surfaces handler errors as-is
  // -------------------------------------------------------------------------
  it('execute rejects with the original error when handler throws', async () => {
    const host = new CommandsCapabilityHost()
    const boom = new Error('boom')
    host.register('alice.demo', 'alice.demo.boom', () => {
      throw boom
    })
    await expect(
      host.execute('alice.demo', 'alice.demo.boom', null)
    ).rejects.toBe(boom)
  })

  // -------------------------------------------------------------------------
  // 6. execute own-namespace missing handler → not_found
  // -------------------------------------------------------------------------
  it('execute rejects with not_found when handler is absent', async () => {
    const host = new CommandsCapabilityHost()
    await expect(
      host.execute('alice.demo', 'alice.demo.missing', null)
    ).rejects.toMatchObject({ code: 'plugin.commands.not_found' })
  })

  // -------------------------------------------------------------------------
  // 7. cross-plugin execute without invoker → access_denied
  // -------------------------------------------------------------------------
  it('execute rejects with access_denied for cross-plugin call with no invoker', async () => {
    const host = new CommandsCapabilityHost()
    await expect(
      host.execute('alice.demo', 'bob.x.y', { something: 1 })
    ).rejects.toMatchObject({ code: 'plugin.commands.access_denied' })
  })

  // -------------------------------------------------------------------------
  // 8. cross-plugin execute with bound invoker — result forwarded
  // -------------------------------------------------------------------------
  it('execute forwards to invoker and returns its result after bindCrossPluginInvoker', async () => {
    const host = new CommandsCapabilityHost()
    const invoker: CrossPluginInvoker = {
      execute: vi.fn().mockResolvedValue('cross-result'),
    }
    host.bindCrossPluginInvoker(invoker)

    const result = await host.execute('alice.demo', 'bob.x.y', { val: 42 })

    expect(result).toBe('cross-result')
    expect(invoker.execute).toHaveBeenCalledWith('alice.demo', 'bob.x.y', {
      val: 42,
    })
  })

  // -------------------------------------------------------------------------
  // 9. disposer removes the command; subsequent execute → not_found
  // -------------------------------------------------------------------------
  it('registration disposer removes the command', async () => {
    const host = new CommandsCapabilityHost()
    const reg = host.register('alice.demo', 'alice.demo.greet', () => 'hi')
    expect(host.has('alice.demo.greet')).toBe(true)
    reg.dispose()
    expect(host.has('alice.demo.greet')).toBe(false)
    await expect(
      host.execute('alice.demo', 'alice.demo.greet', null)
    ).rejects.toMatchObject({ code: 'plugin.commands.not_found' })
  })

  // -------------------------------------------------------------------------
  // 10. unregisterAll removes only the caller's commands
  // -------------------------------------------------------------------------
  it('unregisterAll removes alice.demo.* but leaves bob.x.*', () => {
    const host = new CommandsCapabilityHost()
    host.register('alice.demo', 'alice.demo.a', () => 1)
    host.register('alice.demo', 'alice.demo.b', () => 2)
    host.register('bob.x', 'bob.x.c', () => 3)

    host.unregisterAll('alice.demo')

    expect(host.has('alice.demo.a')).toBe(false)
    expect(host.has('alice.demo.b')).toBe(false)
    expect(host.has('bob.x.c')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 11. bindCrossPluginInvoker replaces the old invoker
  // -------------------------------------------------------------------------
  it('rebinding the invoker replaces the old one', async () => {
    const host = new CommandsCapabilityHost()
    const first: CrossPluginInvoker = {
      execute: vi.fn().mockResolvedValue('first'),
    }
    const second: CrossPluginInvoker = {
      execute: vi.fn().mockResolvedValue('second'),
    }
    host.bindCrossPluginInvoker(first)
    host.bindCrossPluginInvoker(second)

    const result = await host.execute('alice.demo', 'bob.x.cmd', null)

    expect(result).toBe('second')
    expect(first.execute).not.toHaveBeenCalled()
    expect(second.execute).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // 12. execute awaits a Promise-returning handler
  // -------------------------------------------------------------------------
  it('execute awaits a handler that returns a Promise', async () => {
    const host = new CommandsCapabilityHost()
    host.register('alice.demo', 'alice.demo.async', () =>
      Promise.resolve('async-value')
    )
    const result = await host.execute('alice.demo', 'alice.demo.async', null)
    expect(result).toBe('async-value')
  })

  // -------------------------------------------------------------------------
  // Bonus: CommandsError is an instance of Error with correct name
  // -------------------------------------------------------------------------
  it('CommandsError is an Error with the right name and code', () => {
    const err = new CommandsError('plugin.commands.test', 'test msg')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CommandsError')
    expect(err.code).toBe('plugin.commands.test')
    expect(err.message).toBe('test msg')
  })

  // -------------------------------------------------------------------------
  // C3 — manifest declaration enforcement (spec §5 L1741-1746)
  // -------------------------------------------------------------------------
  describe('manifest declaration enforcement', () => {
    it('register throws not_declared_in_manifest for an id absent from the manifest set', () => {
      const host = new CommandsCapabilityHost({
        manifestCommandIds: (caller) =>
          caller === 'alice.demo'
            ? new Set(['alice.demo.greet'])
            : new Set<string>(),
      })
      expect(() =>
        host.register('alice.demo', 'alice.demo.undeclared', () => null)
      ).toThrow(
        expect.objectContaining({
          code: 'plugin.command.not_declared_in_manifest',
        })
      )
    })

    it('register succeeds for an id declared in the manifest set', () => {
      const host = new CommandsCapabilityHost({
        manifestCommandIds: () => new Set(['alice.demo.greet']),
      })
      host.register('alice.demo', 'alice.demo.greet', () => 'ok')
      expect(host.has('alice.demo.greet')).toBe(true)
    })

    it('register throws when the caller is unknown to the manifest resolver', () => {
      const host = new CommandsCapabilityHost({
        manifestCommandIds: () => undefined,
      })
      expect(() =>
        host.register('alice.demo', 'alice.demo.greet', () => null)
      ).toThrow(
        expect.objectContaining({
          code: 'plugin.command.not_declared_in_manifest',
        })
      )
    })

    it('back-compat: register works without a manifest resolver', () => {
      const host = new CommandsCapabilityHost()
      host.register('alice.demo', 'alice.demo.unchecked', () => 'ok')
      expect(host.has('alice.demo.unchecked')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // M11 — self-invoke routes to per-plugin pino log (spec §5 L1800)
  // -------------------------------------------------------------------------
  describe('self-invoke logging', () => {
    it('emits a self-invoke log entry on successful own-namespace execute', async () => {
      const events: Array<{
        callerId: string
        commandId: string
        durMs: number
        ok: boolean
        errorCode?: string
      }> = []
      const host = new CommandsCapabilityHost({
        onSelfInvoke: (e) => events.push(e),
      })
      host.register('alice.demo', 'alice.demo.greet', () => 'hi')
      await host.execute('alice.demo', 'alice.demo.greet', null)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        callerId: 'alice.demo',
        commandId: 'alice.demo.greet',
        ok: true,
      })
      expect(typeof events[0]?.durMs).toBe('number')
    })

    it('emits ok=false + errorCode when own-namespace handler throws', async () => {
      const events: Array<{ ok: boolean; errorCode?: string }> = []
      const host = new CommandsCapabilityHost({
        onSelfInvoke: (e) => events.push(e),
      })
      host.register('alice.demo', 'alice.demo.boom', () => {
        throw new Error('boom')
      })
      await expect(
        host.execute('alice.demo', 'alice.demo.boom', null)
      ).rejects.toThrow('boom')
      expect(events).toHaveLength(1)
      expect(events[0]?.ok).toBe(false)
    })

    it('does NOT call onSelfInvoke for cross-plugin execute', async () => {
      const events: Array<{ ok: boolean }> = []
      const host = new CommandsCapabilityHost({
        onSelfInvoke: (e) => events.push(e),
      })
      const invoker: CrossPluginInvoker = {
        execute: vi.fn().mockResolvedValue('ok'),
      }
      host.bindCrossPluginInvoker(invoker)
      await host.execute('alice.demo', 'bob.x.y', null)
      expect(events).toEqual([])
    })

    it('back-compat: no onSelfInvoke handler → silent success path', async () => {
      const host = new CommandsCapabilityHost()
      host.register('alice.demo', 'alice.demo.greet', () => 'hi')
      const result = await host.execute('alice.demo', 'alice.demo.greet', null)
      expect(result).toBe('hi')
    })
  })

  // -------------------------------------------------------------------------
  // C3 — duplicate registration warns + replaces (spec §5 L1742)
  // -------------------------------------------------------------------------
  describe('duplicate registration', () => {
    it('console.warn is emitted when the same id is registered again', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const host = new CommandsCapabilityHost()
        host.register('alice.demo', 'alice.demo.greet', () => 'first')
        host.register('alice.demo', 'alice.demo.greet', () => 'second')
        expect(warn).toHaveBeenCalledOnce()
        expect(warn.mock.calls[0]?.[0]).toContain('alice.demo.greet')
      } finally {
        warn.mockRestore()
      }
    })

    it('the second handler replaces the first (last write wins)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const host = new CommandsCapabilityHost()
        host.register('alice.demo', 'alice.demo.greet', () => 'first')
        host.register('alice.demo', 'alice.demo.greet', () => 'second')
        const result = await host.execute(
          'alice.demo',
          'alice.demo.greet',
          null
        )
        expect(result).toBe('second')
      } finally {
        warn.mockRestore()
      }
    })
  })
})
