import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from './command-registry'
import { DEFAULT_MENU_CONTEXT } from './menu-context'
import type { Command, CommandDeps } from './types'
import { NEVER } from './when'

const deps = { log: { error: vi.fn() } } as unknown as CommandDeps
const ctx = DEFAULT_MENU_CONTEXT

describe('CommandRegistry', () => {
  it('registers and looks up a command', () => {
    const r = new CommandRegistry()
    const cmd: Command = { id: 'x', title: 'X', run: vi.fn() }
    r.register(cmd)
    expect(r.get('x')).toBe(cmd)
  })

  it('throws on duplicate id', () => {
    const r = new CommandRegistry()
    r.register({ id: 'x', title: 'X', run: vi.fn() })
    expect(() => r.register({ id: 'x', title: 'X', run: vi.fn() })).toThrow()
  })

  it('canExecute returns true when no precondition', () => {
    const r = new CommandRegistry()
    r.register({ id: 'x', title: 'X', run: vi.fn() })
    expect(r.canExecute('x', ctx)).toBe(true)
  })

  it('canExecute returns false when precondition fails', () => {
    const r = new CommandRegistry()
    r.register({ id: 'x', title: 'X', run: vi.fn(), precondition: NEVER })
    expect(r.canExecute('x', ctx)).toBe(false)
  })

  it('execute runs command', async () => {
    const r = new CommandRegistry()
    const run = vi.fn()
    r.register({ id: 'x', title: 'X', run })
    await r.execute('x', undefined, { menuContext: ctx, deps })
    expect(run).toHaveBeenCalledOnce()
  })

  it('execute skips when precondition fails', async () => {
    const r = new CommandRegistry()
    const run = vi.fn()
    r.register({ id: 'x', title: 'X', run, precondition: NEVER })
    await r.execute('x', undefined, { menuContext: ctx, deps })
    expect(run).not.toHaveBeenCalled()
  })

  it('execute no-ops on unknown id', async () => {
    const r = new CommandRegistry()
    await expect(
      r.execute('missing', undefined, { menuContext: ctx, deps })
    ).resolves.toBeUndefined()
  })
})
