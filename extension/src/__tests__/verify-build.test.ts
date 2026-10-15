// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findModuleSyntax } from '#build-verifier'

describe('IIFE module syntax verification', () => {
  it.each([
    ["import 'dependency'", ['static import at 2:3']],
    ["import('dependency')", ['dynamic import at 2:3']],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source for the lexer, not interpolation in this test.
    ['import(`./chunks/${name}.js`)', ['dynamic import at 2:3']],
    ['import.meta.url', ['import.meta at 2:3']],
    ['export const value = 1', ['export at 2:3']],
    [
      "export { value } from 'dependency'",
      ['static import at 2:3', 'export at 2:3'],
    ],
    ["export * from 'dependency'", ['static import at 2:3', 'export at 2:3']],
  ])('reports the syntax and location of %s', (statement, violations) => {
    expect(
      findModuleSyntax(`// content script\n  ${statement}`, 'content.js')
    ).toEqual(violations)
  })

  it('allows import/export text inside comments and strings', () => {
    const source = [
      '(() => {',
      '  // import("comment"); export const ignored = 1;',
      '  const text = "import.meta.url";',
      '  const template = `export { value } from "text"`;',
      '  return [text, template];',
      '})();',
    ].join('\n')

    expect(findModuleSyntax(source, 'content.js')).toEqual([])
  })

  it('detects dynamic imports nested inside a classic IIFE', () => {
    const source = '(() => {\n  return import("dependency");\n})();'

    expect(findModuleSyntax(source, 'content.js')).toEqual([
      'dynamic import at 2:10',
    ])
  })
})
