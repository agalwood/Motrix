import type { MenuContext } from '@shared/types/menu-context'
import { TaskStatus } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MENU_CONTEXT } from './menu-context'
import { ALWAYS, and, ctxEq, ctxIn, ctxTrue, NEVER, not, or } from './when'

const base: MenuContext = { ...DEFAULT_MENU_CONTEXT }

describe('when.ts primitives', () => {
  it('ALWAYS returns true', () => {
    expect(ALWAYS(base)).toBe(true)
  })
  it('NEVER returns false', () => {
    expect(NEVER(base)).toBe(false)
  })
  it('ctxTrue reads boolean keys', () => {
    expect(ctxTrue('taskSelected')(base)).toBe(false)
    expect(ctxTrue('taskSelected')({ ...base, taskSelected: true })).toBe(true)
  })
  it('ctxEq matches exact value', () => {
    const ctx = { ...base, selectedTaskStatus: TaskStatus.Paused }
    expect(ctxEq('selectedTaskStatus', TaskStatus.Paused)(ctx)).toBe(true)
    expect(ctxEq('selectedTaskStatus', TaskStatus.Downloading)(ctx)).toBe(false)
  })
  it('ctxIn matches membership', () => {
    const ctx = { ...base, selectedTaskStatus: TaskStatus.Downloading }
    const expr = ctxIn('selectedTaskStatus', [
      TaskStatus.Downloading,
      TaskStatus.FetchingMetadata,
    ])
    expect(expr(ctx)).toBe(true)
    expect(expr({ ...ctx, selectedTaskStatus: TaskStatus.Paused })).toBe(false)
  })
})

describe('when.ts combinators', () => {
  it('and returns true iff every sub-expr true', () => {
    expect(and(ALWAYS, ALWAYS)(base)).toBe(true)
    expect(and(ALWAYS, NEVER)(base)).toBe(false)
    expect(and()(base)).toBe(true)
  })
  it('or returns true iff any sub-expr true', () => {
    expect(or(NEVER, ALWAYS)(base)).toBe(true)
    expect(or(NEVER, NEVER)(base)).toBe(false)
    expect(or()(base)).toBe(false)
  })
  it('not inverts', () => {
    expect(not(ALWAYS)(base)).toBe(false)
    expect(not(NEVER)(base)).toBe(true)
  })
})
