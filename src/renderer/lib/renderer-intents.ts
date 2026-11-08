import {
  type RendererIntentChannel,
  rendererIntentChannelSchema,
} from '@shared/schemas/renderer-intent'

const consumers = new Map<
  RendererIntentChannel,
  Set<(...args: unknown[]) => unknown>
>()
export function registerIntentConsumer(
  channel: string,
  listener: (...args: unknown[]) => unknown
): () => void {
  const parsed = rendererIntentChannelSchema.safeParse(channel)
  if (!parsed.success) return () => {}
  let listeners = consumers.get(parsed.data)
  if (!listeners) {
    listeners = new Set()
    consumers.set(parsed.data, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export async function applyRendererIntent(
  channel: RendererIntentChannel,
  payload: unknown
): Promise<boolean> {
  const listeners = consumers.get(channel)
  if (!listeners?.size) return false
  for (const listener of [...listeners]) await listener(payload)
  return true
}
