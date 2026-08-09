import type { JsonSchemaNode } from '@shared/types/plugin'
import { z } from 'zod'

// Bounded JSON Schema subset Plan D defined for plugin
// `contributes.configuration.schema`. Renderer uses this to convert manifest
// schemas into Zod schemas at runtime so react-hook-form's zodResolver can
// validate user input. Anything outside the allowlist is a hard error — there
// is no $ref, no allOf, no patternProperties.

const ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'enum',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'default',
  'additionalProperties',
  'secret',
  'title',
  'description',
])

export function jsonSchemaToZod(node: JsonSchemaNode): z.ZodTypeAny {
  for (const k of Object.keys(node)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(`unsupported schema keyword: ${k}`)
    }
  }
  if (Array.isArray(node.enum)) {
    const values = node.enum.filter((v): v is string => typeof v === 'string')
    if (values.length === 0) {
      throw new Error('unsupported schema keyword: enum (non-string values)')
    }
    return z.enum(values as [string, ...string[]])
  }
  switch (node.type) {
    case 'string': {
      let s: z.ZodString = z.string()
      if (node.pattern) s = s.regex(new RegExp(node.pattern))
      if (node.minLength != null) s = s.min(node.minLength)
      if (node.maxLength != null) s = s.max(node.maxLength)
      return s
    }
    case 'integer': {
      let n: z.ZodNumber = z.number().int()
      if (node.minimum != null) n = n.min(node.minimum)
      if (node.maximum != null) n = n.max(node.maximum)
      return n
    }
    case 'number': {
      let n: z.ZodNumber = z.number()
      if (node.minimum != null) n = n.min(node.minimum)
      if (node.maximum != null) n = n.max(node.maximum)
      return n
    }
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array':
      return z.array(jsonSchemaToZod(node.items ?? {}))
    case 'object': {
      const shape: Record<string, z.ZodTypeAny> = {}
      const required = new Set(node.required ?? [])
      for (const [k, v] of Object.entries(node.properties ?? {})) {
        const child = jsonSchemaToZod(v)
        shape[k] = required.has(k) ? child : child.optional()
      }
      let o: z.ZodTypeAny = z.object(shape)
      if (node.additionalProperties === false) {
        o = (o as unknown as { strict(): z.ZodTypeAny }).strict()
      }
      return o
    }
    default:
      return z.unknown()
  }
}

export function defaultFromSchema(
  node: JsonSchemaNode
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.properties ?? {})) {
    if (v.default !== undefined) out[k] = v.default
  }
  return out
}
