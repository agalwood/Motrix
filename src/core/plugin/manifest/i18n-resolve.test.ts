import type { JsonSchemaNode, PluginManifest } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import { PluginManifestInvalid } from './errors'
import { resolveManifestI18n } from './i18n-resolve'

const M: PluginManifest = {
  manifestVersion: 1,
  id: 'alice.demo',
  name: '%name%',
  version: '1.0.0',
  description: '%desc%',
  categories: ['integration'],
  engines: { motrix: '>=2.0.0' },
  main: 'dist/plugin.js',
  permissions: [],
  activationEvents: ['onStartup'],
  contributes: {},
}

const DICT_EN = { name: 'Demo Plugin', desc: 'a demo' }
const DICT_ALT = { name: 'Alt Plugin Name' }

describe('resolveManifestI18n', () => {
  it('replaces whole-field %key% with current dict', () => {
    const r = resolveManifestI18n(M, {
      currentDict: DICT_EN,
      fallbackDict: DICT_EN,
    })
    expect(r.name).toBe('Demo Plugin')
    expect(r.description).toBe('a demo')
  })

  it('falls back to en-US when current dict missing key', () => {
    const r = resolveManifestI18n(M, {
      currentDict: DICT_ALT,
      fallbackDict: DICT_EN,
    })
    expect(r.name).toBe('Alt Plugin Name')
    expect(r.description).toBe('a demo')
  })

  it('keeps literal %key% when neither dict has the key', () => {
    const r = resolveManifestI18n(M, {
      currentDict: {},
      fallbackDict: {},
    })
    expect(r.name).toBe('%name%')
  })

  it('rejects inline mixed placeholders', () => {
    expect(() =>
      resolveManifestI18n(
        { ...M, name: 'prefix %name% suffix' },
        { currentDict: DICT_EN, fallbackDict: DICT_EN }
      )
    ).toThrow(PluginManifestInvalid)
  })

  it('resolves contributes.commands[].title', () => {
    const m: PluginManifest = {
      ...M,
      contributes: {
        commands: [{ id: 'foo', title: '%cmdFoo%' }],
      },
    }
    const r = resolveManifestI18n(m, {
      currentDict: { ...DICT_EN, cmdFoo: 'Run Foo' },
      fallbackDict: { ...DICT_EN, cmdFoo: 'Run Foo' },
    })
    expect(r.contributes.commands?.[0]?.title).toBe('Run Foo')
  })

  it('keeps literal %key% for commands when no dict entry exists', () => {
    const m: PluginManifest = {
      ...M,
      contributes: {
        commands: [{ id: 'foo', title: '%missing%' }],
      },
    }
    const r = resolveManifestI18n(m, { currentDict: {}, fallbackDict: {} })
    expect(r.contributes.commands?.[0]?.title).toBe('%missing%')
  })

  it('resolves configuration.title and configuration.description', () => {
    const m: PluginManifest = {
      ...M,
      contributes: {
        configuration: {
          title: '%cfgTitle%',
          description: '%cfgDesc%',
          schema: { type: 'object' },
        },
      },
    }
    const r = resolveManifestI18n(m, {
      currentDict: { ...DICT_EN, cfgTitle: 'Settings', cfgDesc: 'Setup' },
      fallbackDict: { ...DICT_EN, cfgTitle: 'Settings', cfgDesc: 'Setup' },
    })
    expect(r.contributes.configuration?.title).toBe('Settings')
    expect(r.contributes.configuration?.description).toBe('Setup')
  })

  it('resolves schema.properties.*.title and .description recursively', () => {
    const m: PluginManifest = {
      ...M,
      contributes: {
        configuration: {
          schema: {
            type: 'object',
            properties: {
              apiKey: {
                type: 'string',
                title: '%apiKeyTitle%',
                description: '%apiKeyDesc%',
              },
              server: {
                type: 'object',
                properties: {
                  host: { type: 'string', title: '%hostTitle%' },
                },
              },
            },
          },
        },
      },
    }
    const r = resolveManifestI18n(m, {
      currentDict: {
        ...DICT_EN,
        apiKeyTitle: 'API Key',
        apiKeyDesc: 'Your key',
        hostTitle: 'Host',
      },
      fallbackDict: {
        ...DICT_EN,
        apiKeyTitle: 'API Key',
        apiKeyDesc: 'Your key',
        hostTitle: 'Host',
      },
    })
    const schema = r.contributes.configuration?.schema as {
      properties: Record<string, JsonSchemaNode>
    }
    expect(schema.properties.apiKey?.title).toBe('API Key')
    expect(schema.properties.apiKey?.description).toBe('Your key')
    expect(schema.properties.server?.properties?.host?.title).toBe('Host')
  })

  it('resolves schema.items.title for array types', () => {
    const m: PluginManifest = {
      ...M,
      contributes: {
        configuration: {
          schema: {
            type: 'array',
            items: { type: 'string', title: '%itemTitle%' },
          },
        },
      },
    }
    const r = resolveManifestI18n(m, {
      currentDict: { ...DICT_EN, itemTitle: 'Server URL' },
      fallbackDict: { ...DICT_EN, itemTitle: 'Server URL' },
    })
    const schema = r.contributes.configuration?.schema as JsonSchemaNode
    expect(schema.items?.title).toBe('Server URL')
  })

  it('rejects mixed placeholders inside nested schema titles', () => {
    const m: PluginManifest = {
      ...M,
      contributes: {
        configuration: {
          schema: {
            type: 'object',
            properties: {
              foo: { type: 'string', title: 'prefix %key% suffix' },
            },
          },
        },
      },
    }
    expect(() =>
      resolveManifestI18n(m, { currentDict: DICT_EN, fallbackDict: DICT_EN })
    ).toThrow(PluginManifestInvalid)
  })
})
