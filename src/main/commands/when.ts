import type { MenuContext } from '@shared/types/menu-context'

export type WhenExpr = (ctx: Readonly<MenuContext>) => boolean

export const ALWAYS: WhenExpr = () => true
export const NEVER: WhenExpr = () => false

export const ctxTrue =
  <K extends keyof MenuContext>(key: K): WhenExpr =>
  (ctx) =>
    Boolean(ctx[key])

export const ctxEq =
  <K extends keyof MenuContext>(key: K, value: MenuContext[K]): WhenExpr =>
  (ctx) =>
    ctx[key] === value

export const ctxIn =
  <K extends keyof MenuContext>(
    key: K,
    values: readonly MenuContext[K][]
  ): WhenExpr =>
  (ctx) =>
    values.includes(ctx[key])

export const and =
  (...exprs: WhenExpr[]): WhenExpr =>
  (ctx) =>
    exprs.every((e) => e(ctx))

export const or =
  (...exprs: WhenExpr[]): WhenExpr =>
  (ctx) =>
    exprs.some((e) => e(ctx))

export const not =
  (expr: WhenExpr): WhenExpr =>
  (ctx) =>
    !expr(ctx)
