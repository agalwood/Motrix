import { ErrorCodes, makeMdxpError } from '@motrix/mdxp'
import type { ZodType } from 'zod'
import type { MdxpSessionContext } from './mdxp-session-context'

interface RegisteredMethod {
  readonly schema: ZodType
  readonly handler: (
    params: unknown,
    ctx: MdxpSessionContext
  ) => Promise<unknown> | unknown
}

/**
 * Transport-neutral MDXP request registry. Each method registers its params
 * schema + handler; `dispatch` validates the raw params at the boundary (the
 * single source of validation — handlers receive already-typed params) and
 * routes to the handler with an `MdxpSessionContext`.
 *
 * Both the WebSocket transport (`WebSocketBridgeServer`) and the future unary
 * HTTP transport (Spec 3) register against and call into the same dispatcher,
 * so the method surface is defined once.
 */
export class MdxpDispatcher {
  private readonly methods = new Map<string, RegisteredMethod>()

  /** Register a request method. Re-registering a method overrides it. */
  register<T>(
    method: string,
    schema: ZodType<T>,
    handler: (params: T, ctx: MdxpSessionContext) => Promise<unknown> | unknown
  ): void {
    this.methods.set(method, {
      schema: schema as ZodType,
      handler: handler as RegisteredMethod['handler'],
    })
  }

  has(method: string): boolean {
    return this.methods.has(method)
  }

  /**
   * Validate `rawParams` against the registered schema, then run the handler.
   * Throws `makeMdxpError(InvalidParams)` on validation failure and
   * `makeMdxpError(CapabilityNotSupported)` for an unregistered method.
   */
  async dispatch(
    method: string,
    rawParams: unknown,
    ctx: MdxpSessionContext
  ): Promise<unknown> {
    const entry = this.methods.get(method)
    if (!entry) {
      throw makeMdxpError(
        ErrorCodes.CapabilityNotSupported,
        `unknown method: ${method}`,
        { context: { method } }
      )
    }
    const parsed = entry.schema.safeParse(rawParams)
    if (!parsed.success) {
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        `invalid params for ${method}: ${parsed.error.message}`,
        { context: { method, issues: parsed.error.issues } }
      )
    }
    return entry.handler(parsed.data, ctx)
  }
}
