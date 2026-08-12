import { describe, expect, it } from 'vitest'
import { pluginSecretFields } from './configuration-schema'

describe('pluginSecretFields', () => {
  it('returns only top-level fields marked secret', () => {
    const fields = pluginSecretFields({
      contributes: {
        configuration: {
          schema: {
            type: 'object',
            properties: {
              apiKey: { type: 'string', secret: true },
              quality: { type: 'string' },
            },
          },
        },
      },
    } as never)

    expect([...fields]).toEqual(['apiKey'])
  })

  it('is empty for a missing or malformed configuration schema', () => {
    expect(pluginSecretFields(undefined).size).toBe(0)
    expect(
      pluginSecretFields({
        contributes: { configuration: { schema: null } },
      } as never).size
    ).toBe(0)
  })
})
