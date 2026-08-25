import {
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript documentation gateway has no declarations
import { parseArguments } from '../../scripts/obsidian-docs.mjs'
// @ts-expect-error -- JavaScript documentation gateway has no declarations
import {
  assertProjectMarkdownPath,
  clearLocalContext,
  createDocument,
  deriveProgress,
  loadDocsConfig,
  parseEvalJson,
  parseTaskLines,
  projectPath,
  readLocalContext,
  resolveCreateDocumentPath,
  selectPlanDocuments,
  validateActivePlanDocuments,
  validateDocsConfig,
  validatePlanPair,
  writeLocalContext,
} from '../../scripts/obsidian-docs-lib.mjs'

const config = {
  version: 1,
  vault: 'example-vault',
  projectRoot: 'projects/example',
  repository: 'Motrix',
  contextFile: '.obsidian-doc-context.json',
  commandTimeoutMs: 30_000,
  directories: {
    activeSpecs: '20-active-specs',
    activePlans: '30-active-plans',
    decisions: '40-decisions',
    evidence: '50-evidence',
    publication: '60-publication',
    archivePlans: '90-archive/plans',
    legacyImport: '90-legacy-import',
  },
}

function planDocument(
  documentPath: string,
  language: 'en' | 'zh-CN',
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    path: documentPath,
    basename: path.posix.basename(documentPath, '.md'),
    content,
    metadata: {
      doc_id: 'motrix.plan.sample',
      document_type: 'active-plan',
      language,
      lifecycle: 'active',
      implementation_status: 'in-progress',
      current_task: 'DOC-02',
      last_verified: '2026-08-11',
      path_audit: 'reviewed-against-motrix',
      pair_status: 'paired',
      progress_completed: 1,
      progress_schema: 'stable-task-ids-v1',
      progress_total: 2,
      verified_head: 'abc123',
      verified_repository: 'Motrix',
      bilingual_pair:
        language === 'en'
          ? '[[projects/example/30-active-plans/sample.zh-CN]]'
          : '[[projects/example/30-active-plans/sample]]',
      ...overrides,
    },
  }
}

function activePlanPair() {
  const content = '- [x] [DOC-01] First\n- [ ] [DOC-02] Second'
  const englishPath = 'projects/example/30-active-plans/sample.md'
  const chinesePath = 'projects/example/30-active-plans/sample.zh-CN.md'
  const english = planDocument(englishPath, 'en', content)
  const chinese = planDocument(chinesePath, 'zh-CN', content)
  return [
    {
      ...english,
      pairPath: chinesePath,
      relatedPaths: [],
    },
    {
      ...chinese,
      pairPath: englishPath,
      relatedPaths: [],
    },
  ]
}

describe('Obsidian docs configuration', () => {
  it('accepts a generic vault layout', () => {
    expect(() => validateDocsConfig(config)).not.toThrow()
    expect(projectPath(config, 'activePlans')).toBe(
      'projects/example/30-active-plans'
    )
  })

  it('rejects traversal in configured and requested paths', () => {
    expect(() =>
      validateDocsConfig({
        ...config,
        directories: { ...config.directories, activePlans: '../plans' },
      })
    ).toThrow(/safe relative path/)
    expect(() => assertProjectMarkdownPath(config, '../outside.md')).toThrow(
      /safe relative path/
    )
    expect(() =>
      assertProjectMarkdownPath(config, 'projects/other/plan.md')
    ).toThrow(/must stay under/)
    for (const unsafePath of [
      '..\\outside.json',
      'C:\\outside.json',
      '\\\\server\\share\\outside.json',
    ]) {
      expect(() =>
        validateDocsConfig({ ...config, contextFile: unsafePath })
      ).toThrow(/safe relative path/)
    }
    expect(() =>
      validateDocsConfig({ ...config, contextFile: 'package.json' })
    ).toThrow(/contextFile must be/)
  })

  it('explains how to create an optional local config', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'motrix-docs-'))
    try {
      expect(() => loadDocsConfig(repoRoot)).toThrow(
        /obsidian-docs\.config\.example\.json/
      )
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })
})

describe('stable plan tasks', () => {
  it('parses stable task IDs and derives progress', () => {
    const parsed = parseTaskLines(`## Tasks

- [x] [DOC-01] Add the gateway.
- [ ] [DOC-02] Verify the gateway.
`)
    expect(parsed.duplicates).toEqual([])
    expect(parsed.tasks).toEqual([
      expect.objectContaining({ id: 'DOC-01', done: true, line: 3 }),
      expect.objectContaining({ id: 'DOC-02', done: false, line: 4 }),
    ])
    expect(deriveProgress(parsed.tasks)).toEqual({
      completed: 1,
      currentTask: 'DOC-02',
      implementationStatus: 'in-progress',
      total: 2,
    })
  })

  it('detects duplicate and bilingual task drift', () => {
    const english = planDocument(
      'projects/example/30-active-plans/sample.md',
      'en',
      '- [x] [DOC-01] First\n- [ ] [DOC-01] Duplicate'
    )
    const chinese = planDocument(
      'projects/example/30-active-plans/sample.zh-CN.md',
      'zh-CN',
      '- [ ] [DOC-02] 第二项'
    )
    expect(validatePlanPair(english, chinese)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/duplicate task IDs DOC-01/),
        expect.stringMatching(/task ID order differs/),
        expect.stringMatching(/task completion differs/),
      ])
    )
  })

  it('detects stale frontmatter progress', () => {
    const content = '- [x] [DOC-01] First\n- [x] [DOC-02] Second'
    const english = planDocument(
      'projects/example/30-active-plans/sample.md',
      'en',
      content
    )
    const chinese = planDocument(
      'projects/example/30-active-plans/sample.zh-CN.md',
      'zh-CN',
      content
    )
    expect(validatePlanPair(english, chinese)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/progress_completed is stale/),
        expect.stringMatching(/implementation_status is stale/),
      ])
    )
  })
})

describe('CLI parsing', () => {
  it('parses positional arguments and named values', () => {
    expect(
      parseArguments([
        'task',
        'done',
        'DOC-01',
        '--commit',
        'HEAD',
        '--format',
        'json',
      ])
    ).toEqual({
      positional: ['task', 'done', 'DOC-01'],
      options: { commit: 'HEAD', format: 'json' },
    })
  })

  it('ignores the package-run separator forwarded by pnpm', () => {
    expect(parseArguments(['status', '--', 'motrix.plan.sample'])).toEqual({
      positional: ['status', 'motrix.plan.sample'],
      options: {},
    })
  })

  it('parses create input and overwrite options', () => {
    expect(
      parseArguments([
        'create',
        'decisions',
        'sample.md',
        '--from',
        '/tmp/sample.md',
        '--overwrite',
      ])
    ).toEqual({
      positional: ['create', 'decisions', 'sample.md'],
      options: { from: '/tmp/sample.md', overwrite: true },
    })
  })

  it('parses Obsidian eval output without exposing its prefix', () => {
    expect(parseEvalJson('=> {"ok":true}\n')).toEqual({ ok: true })
    expect(parseEvalJson('debug\n=> [1,2,3]\n')).toEqual([1, 2, 3])
    expect(parseEvalJson('=> {"arrow":"a=>b"}\n')).toEqual({
      arrow: 'a=>b',
    })
  })

  it('stores the selected plan in checkout-local ignored state', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'motrix-docs-'))
    try {
      const localConfig = { ...config, repoRoot }
      const written = writeLocalContext(localConfig, {
        id: 'motrix.plan.sample',
        path: 'projects/example/30-active-plans/sample.md',
      })
      expect(
        lstatSync(path.join(repoRoot, config.contextFile)).mode & 0o077
      ).toBe(0)
      expect(readLocalContext(localConfig)).toEqual(written)
      expect(clearLocalContext(localConfig)).toBe(true)
      expect(readLocalContext(localConfig)).toBeUndefined()
      expect(clearLocalContext(localConfig)).toBe(false)
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })

  it('refuses a symlinked local context file', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'motrix-docs-'))
    const outside = path.join(repoRoot, 'outside.json')
    try {
      writeFileSync(outside, '{"safe":true}\n')
      symlinkSync(outside, path.join(repoRoot, config.contextFile))
      const localConfig = { ...config, repoRoot }
      expect(() =>
        writeLocalContext(localConfig, {
          id: 'example.plan.sample',
          path: 'projects/example/30-active-plans/sample.md',
        })
      ).toThrow(/symlink/)
      expect(() => clearLocalContext(localConfig)).toThrow(/symlink/)
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  })
})

describe('document creation', () => {
  it('resolves configured directories and invokes Obsidian without a shell', () => {
    const calls: Array<{ args: string[]; config: unknown }> = []
    const result = createDocument(
      config,
      {
        content: '# Decision\n',
        filename: 'media/sample.md',
        kind: 'decisions',
        overwrite: true,
      },
      {
        inspect: () => ({ exists: true, markdown: true }),
        run: (receivedConfig: unknown, args: string[]) => {
          calls.push({ args, config: receivedConfig })
          return ''
        },
      }
    )

    expect(result).toEqual({
      created: false,
      overwritten: true,
      path: 'projects/example/40-decisions/media/sample.md',
    })
    expect(calls).toEqual([
      {
        args: [
          'create',
          'path=projects/example/40-decisions/media/sample.md',
          'content=# Decision\n',
          'overwrite',
        ],
        config,
      },
    ])
  })

  it('leaves overwrite disabled unless it is explicitly requested', () => {
    const calls: string[][] = []
    createDocument(
      config,
      {
        filename: 'sample.md',
        kind: 'decisions',
      },
      {
        inspect: () => ({ exists: false, markdown: false }),
        run: (_receivedConfig: unknown, args: string[]) => {
          calls.push(args)
          return ''
        },
      }
    )

    expect(calls).toEqual([
      ['create', 'path=projects/example/40-decisions/sample.md', 'content='],
    ])
  })

  it('rejects an existing document before invoking the create command', () => {
    const run = () => {
      throw new Error('create should not run')
    }
    expect(() =>
      createDocument(
        config,
        {
          filename: 'sample.md',
          kind: 'decisions',
        },
        {
          inspect: () => ({ exists: true, markdown: true }),
          run,
        }
      )
    ).toThrow(/already exists/)
  })

  it('rejects unknown directories, traversal, and non-Markdown paths', () => {
    expect(() =>
      resolveCreateDocumentPath(config, 'unknown', 'sample.md')
    ).toThrow(/must be one of/)
    expect(() =>
      resolveCreateDocumentPath(config, 'decisions', '../sample.md')
    ).toThrow(/safe relative path/)
    expect(() =>
      resolveCreateDocumentPath(config, 'decisions', 'sample.txt')
    ).toThrow(/must end with .md/)
  })

  it('rejects content that cannot be passed safely to the CLI', () => {
    expect(() =>
      createDocument(
        config,
        {
          content: 'unsafe\0content',
          filename: 'sample.md',
          kind: 'decisions',
        },
        { inspect: () => ({ exists: false, markdown: false }) }
      )
    ).toThrow(/NUL/)
    expect(() =>
      createDocument(
        config,
        {
          content: 'x'.repeat(512 * 1024 + 1),
          filename: 'sample.md',
          kind: 'decisions',
        },
        { inspect: () => ({ exists: false, markdown: false }) }
      )
    ).toThrow(/must not exceed/)
  })
})

describe('plan selection security', () => {
  it('selects one validated bilingual plan pair', () => {
    const index = activePlanPair()
    expect(selectPlanDocuments(config, index, 'motrix.plan.sample')).toEqual({
      pairPath: 'projects/example/30-active-plans/sample.zh-CN.md',
      paths: [
        'projects/example/30-active-plans/sample.md',
        'projects/example/30-active-plans/sample.zh-CN.md',
      ],
      planPath: 'projects/example/30-active-plans/sample.md',
    })
  })

  it('rejects ambiguous IDs and pairs outside the active-plan root', () => {
    const index = activePlanPair()
    const duplicate = activePlanPair().map((document) => ({
      ...document,
      path: document.path.replace('sample', 'second'),
      basename: document.basename.replace('sample', 'second'),
      pairPath: document.pairPath.replace('sample', 'second'),
      metadata: {
        ...document.metadata,
        bilingual_pair: String(document.metadata.bilingual_pair).replace(
          'sample',
          'second'
        ),
      },
    }))
    expect(() =>
      selectPlanDocuments(
        config,
        [...index, ...duplicate],
        'motrix.plan.sample'
      )
    ).toThrow(/Ambiguous/)

    const unsafe = activePlanPair()
    unsafe[1] = {
      ...unsafe[1],
      path: 'projects/example/40-decisions/sample.zh-CN.md',
      pairPath: unsafe[0].path,
    }
    unsafe[0] = { ...unsafe[0], pairPath: unsafe[1].path }
    expect(() =>
      selectPlanDocuments(config, unsafe, 'motrix.plan.sample')
    ).toThrow(/leaves its directory/)
  })

  it('reports missing metadata, duplicate identities, and invalid pairs', () => {
    const pair = activePlanPair()
    const invalid = {
      ...pair[0],
      path: 'projects/example/30-active-plans/invalid.md',
      metadata: {},
    }
    const duplicate = {
      ...pair[0],
      path: 'projects/example/30-active-plans/duplicate.md',
      basename: 'duplicate',
    }
    const result = validateActivePlanDocuments(config, [
      ...pair,
      invalid,
      duplicate,
    ])
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unsupported or missing document_type/),
        expect.stringMatching(/language must be en or zh-CN/),
        expect.stringMatching(/missing doc_id/),
        expect.stringMatching(/duplicate doc_id\/language/),
      ])
    )
  })
})
