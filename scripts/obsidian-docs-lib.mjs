import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/
export const LOCAL_CONTEXT_FILE = '.obsidian-doc-context.json'
export const MAX_CREATE_CONTENT_BYTES = 512 * 1024

const DOCUMENT_DIRECTORY_KEYS = Object.freeze({
  'archive-plans': 'archivePlans',
  decisions: 'decisions',
  evidence: 'evidence',
  'legacy-import': 'legacyImport',
  plans: 'activePlans',
  publication: 'publication',
  specs: 'activeSpecs',
})

const TASK_LINE_PATTERN =
  /^(\s*-\s+\[)([ xX])(\]\s+\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]\s+)(.+)$/

const OPEN_MIGRATION_STATUSES = new Set([
  'bootstrap',
  'draft',
  'in-progress',
  'needs-review',
])

function stripUnsafeControlCharacters(value) {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0)
      return (
        character === '\n' ||
        character === '\r' ||
        character === '\t' ||
        (code >= 0x20 && code !== 0x7f)
      )
    })
    .join('')
}

export function loadDocsConfig(repoRoot, configPath) {
  if (configPath !== undefined && typeof configPath !== 'string') {
    throw new Error('--config requires a file path')
  }
  const resolvedPath = path.resolve(
    repoRoot,
    configPath ?? 'obsidian-docs.config.json'
  )
  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Obsidian docs config not found: ${resolvedPath}. Copy obsidian-docs.config.example.json to obsidian-docs.config.json and customize the ignored local file.`
    )
  }
  const config = JSON.parse(readFileSync(resolvedPath, 'utf8'))
  validateDocsConfig(config)
  return { ...config, configPath: resolvedPath, repoRoot }
}

export function validateDocsConfig(config) {
  if (config?.version !== 1) {
    throw new Error('obsidian docs config version must be 1')
  }
  for (const key of ['vault', 'projectRoot', 'repository', 'contextFile']) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      throw new Error(`obsidian docs config requires ${key}`)
    }
  }
  if (/[^\P{Cc}\t]/u.test(config.vault) || config.vault.length > 200) {
    throw new Error('vault must not contain control characters')
  }
  if (
    !Number.isInteger(config.commandTimeoutMs) ||
    config.commandTimeoutMs < 1_000
  ) {
    throw new Error('commandTimeoutMs must be an integer of at least 1000')
  }
  const requiredDirectories = [
    'activeSpecs',
    'activePlans',
    'decisions',
    'evidence',
    'publication',
    'archivePlans',
    'legacyImport',
  ]
  for (const key of requiredDirectories) {
    const value = config.directories?.[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`obsidian docs config requires directories.${key}`)
    }
    assertRelativePath(value, `directories.${key}`)
  }
  assertRelativePath(config.projectRoot, 'projectRoot')
  assertRelativePath(config.contextFile, 'contextFile')
  if (config.contextFile !== LOCAL_CONTEXT_FILE) {
    throw new Error(`contextFile must be ${LOCAL_CONTEXT_FILE}`)
  }
}

function assertRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value
      .split('/')
      .some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a safe relative path`)
  }
}

function isWithinPosixPath(root, candidate) {
  const relative = path.posix.relative(root, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith('../') &&
    !path.posix.isAbsolute(relative)
  )
}

export function projectPath(config, directoryKey, filename = '') {
  const directory = config.directories[directoryKey]
  if (!directory) throw new Error(`Unknown docs directory: ${directoryKey}`)
  return [config.projectRoot, directory, filename].filter(Boolean).join('/')
}

export function assertProjectMarkdownPath(config, vaultPath) {
  assertRelativePath(vaultPath, 'Vault path')
  if (
    !isWithinPosixPath(config.projectRoot, vaultPath) ||
    !vaultPath.endsWith('.md')
  ) {
    throw new Error(
      `Markdown path must stay under ${config.projectRoot}: ${vaultPath}`
    )
  }
  return vaultPath
}

export function assertActivePlanMarkdownPath(config, vaultPath) {
  assertProjectMarkdownPath(config, vaultPath)
  const activePlansRoot = projectPath(config, 'activePlans')
  if (!isWithinPosixPath(activePlansRoot, vaultPath)) {
    throw new Error(
      `Active plan path must stay under ${activePlansRoot}: ${vaultPath}`
    )
  }
  return vaultPath
}

export function resolveCreateDocumentPath(config, kind, filename) {
  const directoryKey = DOCUMENT_DIRECTORY_KEYS[kind]
  if (!directoryKey) {
    throw new Error(
      `Document directory must be one of: ${Object.keys(
        DOCUMENT_DIRECTORY_KEYS
      ).join(', ')}`
    )
  }
  if (typeof filename !== 'string' || !filename.endsWith('.md')) {
    throw new Error('Document path must end with .md')
  }
  return assertProjectMarkdownPath(
    config,
    projectPath(config, directoryKey, filename)
  )
}

export function inspectDocument(config, vaultPath) {
  assertProjectMarkdownPath(config, vaultPath)
  const code = `(async()=>{const path=${JSON.stringify(
    vaultPath
  )};const entry=app.vault.getAbstractFileByPath(path);return JSON.stringify({exists:Boolean(entry),markdown:Boolean(entry&&entry.extension==="md")})})()`
  return evaluateObsidian(config, code)
}

export function createDocument(config, options, dependencies = {}) {
  const vaultPath = resolveCreateDocumentPath(
    config,
    options.kind,
    options.filename
  )
  const content = options.content ?? ''
  if (typeof content !== 'string') {
    throw new Error('Document content must be a string')
  }
  if (content.includes('\0')) {
    throw new Error('Document content must not contain NUL characters')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CREATE_CONTENT_BYTES) {
    throw new Error(
      `Document content must not exceed ${MAX_CREATE_CONTENT_BYTES} bytes`
    )
  }
  const inspect = dependencies.inspect ?? inspectDocument
  const runner = dependencies.run ?? runObsidian
  const existing = inspect(config, vaultPath)
  if (existing.exists && !existing.markdown) {
    throw new Error(`Vault path is not a Markdown file: ${vaultPath}`)
  }
  if (existing.exists && options.overwrite !== true) {
    throw new Error(
      `Document already exists; pass --overwrite to replace it: ${vaultPath}`
    )
  }
  const args = ['create', `path=${vaultPath}`, `content=${content}`]
  if (options.overwrite === true) args.push('overwrite')
  runner(config, args)
  return {
    created: !existing.exists,
    overwritten: existing.exists,
    path: vaultPath,
  }
}

export function parseTaskLines(content) {
  const tasks = []
  const seen = new Set()
  const duplicates = new Set()
  const lines = content.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const match = TASK_LINE_PATTERN.exec(lines[index])
    if (!match) continue
    const id = match[4]
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
    tasks.push({
      id,
      description: match[5],
      done: match[2].toLowerCase() === 'x',
      line: index + 1,
      text: lines[index],
    })
  }

  return { duplicates: [...duplicates].sort(), tasks }
}

export function deriveProgress(tasks) {
  const completed = tasks.filter((task) => task.done).length
  const total = tasks.length
  const currentTask = tasks.find((task) => !task.done)?.id
  const implementationStatus =
    completed === 0
      ? 'not-started'
      : completed === total
        ? 'verification'
        : 'in-progress'
  return { completed, currentTask, implementationStatus, total }
}

export function validatePlanPair(english, chinese, options = {}) {
  const errors = []
  const repository = options.repository ?? 'Motrix'
  const englishParsed = parseTaskLines(english.content)
  const chineseParsed = parseTaskLines(chinese.content)
  const englishIds = englishParsed.tasks.map((task) => task.id)
  const chineseIds = chineseParsed.tasks.map((task) => task.id)
  const englishStates = englishParsed.tasks.map((task) => task.done)
  const chineseStates = chineseParsed.tasks.map((task) => task.done)

  if (englishParsed.duplicates.length > 0) {
    errors.push(
      `${english.path}: duplicate task IDs ${englishParsed.duplicates.join(', ')}`
    )
  }
  if (chineseParsed.duplicates.length > 0) {
    errors.push(
      `${chinese.path}: duplicate task IDs ${chineseParsed.duplicates.join(', ')}`
    )
  }
  if (englishIds.length === 0) {
    errors.push(`${english.path}: no stable task IDs found`)
  }
  if (JSON.stringify(englishIds) !== JSON.stringify(chineseIds)) {
    errors.push(`${english.path}: bilingual task ID order differs`)
  }
  if (JSON.stringify(englishStates) !== JSON.stringify(chineseStates)) {
    errors.push(`${english.path}: bilingual task completion differs`)
  }

  const englishProgress = deriveProgress(englishParsed.tasks)
  const chineseProgress = deriveProgress(chineseParsed.tasks)
  for (const document of [english, chinese]) {
    const metadata = document.metadata ?? {}
    const progress = document === english ? englishProgress : chineseProgress
    const required = [
      'doc_id',
      'implementation_status',
      'last_verified',
      'path_audit',
      'progress_schema',
      'verified_head',
      'verified_repository',
      'bilingual_pair',
    ]
    for (const key of required) {
      if (metadata[key] === undefined || metadata[key] === '') {
        errors.push(`${document.path}: missing ${key}`)
      }
    }
    if (metadata.verified_repository !== repository) {
      errors.push(`${document.path}: verified_repository must be ${repository}`)
    }
    if (metadata.progress_schema !== 'stable-task-ids-v1') {
      errors.push(`${document.path}: unsupported progress_schema`)
    }
    if (metadata.pair_status !== 'paired') {
      errors.push(`${document.path}: pair_status must be paired`)
    }
    if (!String(metadata.lifecycle ?? '').startsWith('active')) {
      errors.push(`${document.path}: lifecycle must start with active`)
    }
    if (metadata.progress_completed !== progress.completed) {
      errors.push(`${document.path}: progress_completed is stale`)
    }
    if (metadata.progress_total !== progress.total) {
      errors.push(`${document.path}: progress_total is stale`)
    }
    if (metadata.implementation_status !== progress.implementationStatus) {
      errors.push(`${document.path}: implementation_status is stale`)
    }
    if ((metadata.current_task ?? undefined) !== progress.currentTask) {
      errors.push(`${document.path}: current_task is stale`)
    }
  }

  if (english.metadata?.doc_id !== chinese.metadata?.doc_id) {
    errors.push(`${english.path}: bilingual doc_id differs`)
  }
  for (const document of [english, chinese]) {
    if (document.metadata?.document_type !== 'active-plan') {
      errors.push(`${document.path}: document_type must be active-plan`)
    }
  }
  if (english.metadata?.language !== 'en') {
    errors.push(`${english.path}: language must be en`)
  }
  if (chinese.metadata?.language !== 'zh-CN') {
    errors.push(`${chinese.path}: language must be zh-CN`)
  }
  if (wikilinkPath(english.metadata?.bilingual_pair) !== chinese.path) {
    errors.push(`${english.path}: bilingual_pair is not reciprocal`)
  }
  if (wikilinkPath(chinese.metadata?.bilingual_pair) !== english.path) {
    errors.push(`${chinese.path}: bilingual_pair is not reciprocal`)
  }
  return errors
}

function wikilinkPath(value) {
  const target = String(value ?? '').match(/\[\[([^\]|#]+)/)?.[1]
  if (!target) return undefined
  return target.endsWith('.md') ? target : `${target}.md`
}

export function parseEvalJson(output) {
  const lines = output.trim().split(/\r?\n/)
  const markerLine = lines.findIndex((line) =>
    line.trimStart().startsWith('=>')
  )
  const payload =
    markerLine >= 0
      ? [
          lines[markerLine].slice(lines[markerLine].indexOf('=>') + 2),
          ...lines.slice(markerLine + 1),
        ]
          .join('\n')
          .trim()
      : lines.join('\n').trim()
  if (!payload) throw new Error('Obsidian eval returned no JSON payload')
  return JSON.parse(payload)
}

export function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
  })
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const rawDetail = [
      result.stderr,
      options.includeStdoutOnError ? result.stdout : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim()
    const detail = stripUnsafeControlCharacters(rawDetail).slice(0, 4_000)
    const displayArgs = options.redactArgs
      ? '[arguments redacted]'
      : args.join(' ')
    throw new Error(
      `${command} ${displayArgs} exited ${result.status}${
        detail ? `\n${detail}` : ''
      }`
    )
  }
  return result.stdout.trim()
}

export function runObsidian(config, args) {
  return runProcess('obsidian', [`vault=${config.vault}`, ...args], {
    cwd: config.repoRoot,
    redactArgs: true,
    timeoutMs: config.commandTimeoutMs,
  })
}

export function evaluateObsidian(config, code) {
  return parseEvalJson(runObsidian(config, ['eval', `code=${code}`]))
}

export function getGitState(config) {
  const branch = runProcess('git', ['branch', '--show-current'], {
    cwd: config.repoRoot,
  })
  const head = runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: config.repoRoot,
  })
  return { branch, head }
}

export function resolveGitCommit(config, ref) {
  return runProcess('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: config.repoRoot,
  })
}

export function contextFilePath(config) {
  if (config.contextFile !== LOCAL_CONTEXT_FILE) {
    throw new Error(`contextFile must be ${LOCAL_CONTEXT_FILE}`)
  }
  const repoRoot = path.resolve(config.repoRoot)
  const target = path.resolve(repoRoot, config.contextFile)
  if (path.dirname(target) !== repoRoot) {
    throw new Error('Local context file must stay at the repository root')
  }
  return target
}

function assertSafeContextFile(target) {
  if (!existsSync(target)) return false
  const stats = lstatSync(target)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Local context path must be a regular file, not a symlink')
  }
  return true
}

export function readLocalContext(config) {
  const target = contextFilePath(config)
  if (!assertSafeContextFile(target)) return undefined
  const context = JSON.parse(readFileSync(target, 'utf8'))
  if (typeof context.planId !== 'string' || context.planId.length === 0) {
    throw new Error(`${config.contextFile} does not contain planId`)
  }
  if (typeof context.planPath !== 'string') {
    throw new Error(`${config.contextFile} does not contain planPath`)
  }
  assertActivePlanMarkdownPath(config, context.planPath)
  return context
}

export function clearLocalContext(config) {
  const target = contextFilePath(config)
  if (!assertSafeContextFile(target)) return false
  unlinkSync(target)
  return true
}

export function writeLocalContext(config, plan) {
  if (typeof plan.id !== 'string' || plan.id.length === 0) {
    throw new Error('Selected plan requires a document ID')
  }
  assertActivePlanMarkdownPath(config, plan.path)
  const context = {
    planId: plan.id,
    planPath: plan.path,
    selectedAt: new Date().toISOString(),
  }
  const target = contextFilePath(config)
  assertSafeContextFile(target)
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(context, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, target)
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
  return context
}

export function listDocuments(config, kind) {
  const directoryKey =
    kind === 'plans'
      ? 'activePlans'
      : kind === 'specs'
        ? 'activeSpecs'
        : undefined
  if (!directoryKey) throw new Error('Document kind must be plans or specs')
  const folder = projectPath(config, directoryKey)
  const code = `(async()=>{const folder=${JSON.stringify(
    folder
  )};const files=app.vault.getMarkdownFiles().filter(f=>f.path.startsWith(folder+"/"));const rows=[];for(const file of files){const metadata=app.metadataCache.getFileCache(file)?.frontmatter||{};if(!metadata.language)continue;rows.push({path:file.path,id:metadata.doc_id||file.basename.replace(/\\.zh-CN$/,"") ,language:metadata.language,document_type:metadata.document_type,lifecycle:metadata.lifecycle,implementation_status:metadata.implementation_status,verified_head:metadata.verified_head,bilingual_pair:metadata.bilingual_pair});}rows.sort((a,b)=>a.path.localeCompare(b.path));return JSON.stringify(rows)})()`
  return evaluateObsidian(config, code)
}

const DOCUMENT_ROOTS = Object.freeze([
  ['activePlans', 'active-plan'],
  ['activeSpecs', 'active-spec'],
  ['decisions', 'decision'],
  ['evidence', 'evidence'],
])

function documentRoot(config, vaultPath) {
  return DOCUMENT_ROOTS.find(([directoryKey]) =>
    isWithinPosixPath(projectPath(config, directoryKey), vaultPath)
  )
}

function documentIndexCode(config) {
  const roots = DOCUMENT_ROOTS.map(([directoryKey]) => ({
    directoryKey,
    path: projectPath(config, directoryKey),
  }))
  return `(async()=>{const roots=${JSON.stringify(
    roots
  )};const under=(root,candidate)=>candidate.startsWith(root+"/");const files=app.vault.getMarkdownFiles().filter(file=>roots.some(root=>under(root.path,file.path)));const rows=[];for(const file of files){const cache=app.metadataCache.getFileCache(file)||{};const metadata=cache.frontmatter||{};const pairLink=String(metadata.bilingual_pair||"").match(/\\[\\[([^\\]|#]+)/)?.[1];const pair=pairLink?app.metadataCache.getFirstLinkpathDest(pairLink,file.path):null;const relatedPaths=[];for(const link of [...(cache.links||[]),...(cache.frontmatterLinks||[])]){const target=app.metadataCache.getFirstLinkpathDest(link.link,file.path);if(target&&roots.some(root=>root.directoryKey!=="activePlans"&&under(root.path,target.path)))relatedPaths.push(target.path)}rows.push({path:file.path,basename:file.basename,metadata,pairPath:pair?.path,relatedPaths:[...new Set(relatedPaths)].sort()})}rows.sort((a,b)=>a.path.localeCompare(b.path));return JSON.stringify(rows)})()`
}

function readDocumentsCode(paths) {
  return `(async()=>{const paths=${JSON.stringify(
    paths
  )};const documents=[];for(const path of paths){const file=app.vault.getAbstractFileByPath(path);if(!file||file.extension!=="md")throw new Error("Allowed Markdown file not found");const cache=app.metadataCache.getFileCache(file)||{};const metadata=cache.frontmatter||{};const pairLink=String(metadata.bilingual_pair||"").match(/\\[\\[([^\\]|#]+)/)?.[1];const pair=pairLink?app.metadataCache.getFirstLinkpathDest(pairLink,file.path):null;documents.push({path:file.path,metadata,pairPath:pair?.path,content:await app.vault.cachedRead(file)})}documents.sort((a,b)=>a.path.localeCompare(b.path));return JSON.stringify(documents)})()`
}

function assertDocumentPair(config, byPath, candidate, expectedRootKey) {
  if (!candidate) throw new Error('Selected document is missing')
  const root = documentRoot(config, candidate.path)
  if (!root || root[0] !== expectedRootKey) {
    throw new Error(`Document is outside ${expectedRootKey}: ${candidate.path}`)
  }
  if (candidate.metadata?.document_type !== root[1]) {
    throw new Error(`${candidate.path}: document_type must be ${root[1]}`)
  }
  if (!candidate.pairPath) {
    throw new Error(`${candidate.path}: bilingual pair is missing`)
  }
  const pair = byPath.get(candidate.pairPath)
  if (!pair) throw new Error(`${candidate.path}: bilingual pair is not allowed`)
  const pairRoot = documentRoot(config, pair.path)
  if (!pairRoot || pairRoot[0] !== expectedRootKey) {
    throw new Error(`${candidate.path}: bilingual pair leaves its directory`)
  }
  if (pair.metadata?.document_type !== root[1]) {
    throw new Error(`${pair.path}: document_type must be ${root[1]}`)
  }
  const languages = new Set([
    candidate.metadata?.language,
    pair.metadata?.language,
  ])
  if (!languages.has('en') || !languages.has('zh-CN') || languages.size !== 2) {
    throw new Error(`${candidate.path}: pair languages must be en and zh-CN`)
  }
  const english = candidate.metadata.language === 'en' ? candidate : pair
  const chinese = english === candidate ? pair : candidate
  const expectedChinesePath = english.path.replace(/\.md$/, '.zh-CN.md')
  if (
    english.path.endsWith('.zh-CN.md') ||
    chinese.path !== expectedChinesePath
  ) {
    throw new Error(
      `${candidate.path}: bilingual filenames do not match language`
    )
  }
  if (
    !candidate.metadata?.doc_id ||
    candidate.metadata.doc_id !== pair.metadata?.doc_id
  ) {
    throw new Error(`${candidate.path}: bilingual doc_id differs or is missing`)
  }
  if (pair.pairPath !== candidate.path) {
    throw new Error(`${candidate.path}: bilingual pair is not reciprocal`)
  }
  return { english, chinese }
}

export function selectPlanDocuments(config, index, ref, options = {}) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 500) {
    throw new Error('Plan reference must be a non-empty string')
  }
  const byPath = new Map()
  for (const document of index) {
    if (byPath.has(document.path)) {
      throw new Error(`Duplicate indexed path: ${document.path}`)
    }
    byPath.set(document.path, document)
  }
  const activePlans = index.filter(
    (document) => documentRoot(config, document.path)?.[0] === 'activePlans'
  )
  const matches = activePlans.filter(
    (document) =>
      document.path === ref ||
      document.basename === ref ||
      document.metadata?.doc_id === ref
  )
  if (matches.length === 0) throw new Error(`Active plan not found: ${ref}`)

  const resolvedPairs = matches.map((candidate) =>
    assertDocumentPair(config, byPath, candidate, 'activePlans')
  )
  const englishPaths = new Set(resolvedPairs.map((pair) => pair.english.path))
  if (englishPaths.size !== 1) {
    throw new Error(`Ambiguous active plan reference: ${ref}`)
  }
  const plan = resolvedPairs[0].english
  const pair = resolvedPairs[0].chinese
  const selected = new Set([plan.path, pair.path])

  if (options.includeRelated) {
    for (const source of [plan, pair]) {
      for (const relatedPath of source.relatedPaths ?? []) {
        const related = byPath.get(relatedPath)
        const root = related && documentRoot(config, related.path)
        if (!related || !root || root[0] === 'activePlans') continue
        const relatedPair = assertDocumentPair(config, byPath, related, root[0])
        selected.add(relatedPair.english.path)
        selected.add(relatedPair.chinese.path)
      }
    }
  }
  return {
    pairPath: pair.path,
    paths: [...selected].sort(),
    planPath: plan.path,
  }
}

export function readPlanBundle(config, ref, options = {}) {
  const index = evaluateObsidian(config, documentIndexCode(config))
  const selection = selectPlanDocuments(config, index, ref, options)
  const documents = evaluateObsidian(config, readDocumentsCode(selection.paths))
  const byPath = new Map(documents.map((document) => [document.path, document]))
  for (const document of documents) {
    const root = documentRoot(config, document.path)
    if (!root) throw new Error(`Document left allowed roots: ${document.path}`)
    assertDocumentPair(config, byPath, document, root[0])
  }
  const english = byPath.get(selection.planPath)
  const chinese = byPath.get(selection.pairPath)
  const errors = validatePlanPair(english, chinese, {
    repository: config.repository,
  })
  if (errors.length > 0) throw new Error(errors.join('\n'))
  for (const document of documents) delete document.pairPath
  return { ...selection, documents }
}

export function resolvePlanReference(config, explicitRef) {
  if (explicitRef) return explicitRef
  const context = readLocalContext(config)
  if (!context) {
    throw new Error(
      `No plan selected. Run "pnpm run docs:use -- <plan-id>" first.`
    )
  }
  return context.planPath
}

export function planSummary(bundle, gitState) {
  const plan = bundle.documents.find(
    (document) => document.path === bundle.planPath
  )
  const pair = bundle.documents.find(
    (document) => document.path === bundle.pairPath
  )
  if (!plan || !pair) throw new Error('Plan bundle is missing its pair')
  const parsed = parseTaskLines(plan.content)
  const progress = deriveProgress(parsed.tasks)
  const verifiedHead = plan.metadata.verified_head
  const head = gitState.head
  const matchesVerifiedHead =
    Boolean(verifiedHead && head) &&
    (verifiedHead === head ||
      verifiedHead.startsWith(head) ||
      head.startsWith(verifiedHead))
  return {
    id: plan.metadata.doc_id ?? path.basename(plan.path, '.md'),
    path: plan.path,
    pairPath: pair.path,
    branch: gitState.branch,
    head,
    verifiedHead,
    requiresRevalidation: !matchesVerifiedHead,
    lastProgressHead: plan.metadata.last_progress_head,
    implementationStatus: plan.metadata.implementation_status,
    progress,
    tasks: parsed.tasks,
  }
}

export function readAllActivePlanDocuments(config) {
  const index = evaluateObsidian(config, documentIndexCode(config))
  const paths = index
    .filter(
      (document) => documentRoot(config, document.path)?.[0] === 'activePlans'
    )
    .map((document) => document.path)
  return evaluateObsidian(config, readDocumentsCode(paths))
}

export function validateActivePlanDocuments(config, documents) {
  const byPath = new Map(documents.map((document) => [document.path, document]))
  const errors = []
  const warnings = []
  let pairCount = 0

  const supportedTypes = new Set([
    'active-plan',
    'active-plan-index',
    'plan-index',
  ])
  const identities = new Map()
  const basenames = new Map()
  for (const document of documents) {
    try {
      assertActivePlanMarkdownPath(config, document.path)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    const metadata = document.metadata ?? {}
    if (!supportedTypes.has(metadata.document_type)) {
      errors.push(`${document.path}: unsupported or missing document_type`)
    }
    if (metadata.language !== 'en' && metadata.language !== 'zh-CN') {
      errors.push(`${document.path}: language must be en or zh-CN`)
    }
    if (typeof metadata.doc_id !== 'string' || metadata.doc_id.length === 0) {
      errors.push(`${document.path}: missing doc_id`)
    } else if (metadata.language === 'en' || metadata.language === 'zh-CN') {
      const key = `${metadata.doc_id}\u0000${metadata.language}`
      const previous = identities.get(key)
      if (previous) {
        errors.push(
          `${document.path}: duplicate doc_id/language also used by ${previous}`
        )
      } else {
        identities.set(key, document.path)
      }
    }
    const basename = path.posix.basename(document.path)
    const previousBasename = basenames.get(basename)
    if (previousBasename) {
      errors.push(
        `${document.path}: duplicate basename also used by ${previousBasename}`
      )
    } else {
      basenames.set(basename, document.path)
    }
    if (
      (metadata.language === 'en' && document.path.endsWith('.zh-CN.md')) ||
      (metadata.language === 'zh-CN' && !document.path.endsWith('.zh-CN.md'))
    ) {
      errors.push(`${document.path}: filename does not match language`)
    }
  }

  const executable = documents.filter(
    (document) => document.metadata?.document_type === 'active-plan'
  )
  for (const english of executable.filter(
    (document) => document.metadata?.language === 'en'
  )) {
    try {
      const pair = assertDocumentPair(config, byPath, english, 'activePlans')
      pairCount += 1
      errors.push(
        ...validatePlanPair(pair.english, pair.chinese, {
          repository: config.repository,
        })
      )
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    if (OPEN_MIGRATION_STATUSES.has(english.metadata?.migration_status)) {
      warnings.push(`${english.path}: migration_status is still open`)
    }
  }

  for (const document of executable.filter(
    (candidate) => candidate.metadata?.language === 'zh-CN'
  )) {
    const english = executable.find(
      (candidate) =>
        candidate.metadata?.language === 'en' &&
        candidate.metadata?.doc_id === document.metadata?.doc_id
    )
    if (!english) errors.push(`${document.path}: English document not found`)
  }
  return {
    documentCount: documents.length,
    errors,
    executableDocumentCount: executable.length,
    indexDocumentCount: documents.length - executable.length,
    pairCount,
    warnings,
  }
}

export function checkActivePlans(config) {
  return validateActivePlanDocuments(config, readAllActivePlanDocuments(config))
}

export function updatePlanTask(config, options) {
  if (!TASK_ID_PATTERN.test(options.taskId)) {
    throw new Error(`Invalid task ID: ${options.taskId}`)
  }
  const bundle = readPlanBundle(config, options.planRef)
  const gitState = getGitState(config)
  const commit = options.done
    ? resolveGitCommit(config, options.commitRef)
    : gitState.head
  const paths = [bundle.planPath, bundle.pairPath]
  for (const vaultPath of paths) {
    assertActivePlanMarkdownPath(config, vaultPath)
  }

  const code = `(async()=>{const paths=${JSON.stringify(
    paths
  )};const taskId=${JSON.stringify(options.taskId)};const done=${JSON.stringify(
    options.done
  )};const commit=${JSON.stringify(commit)};const branch=${JSON.stringify(
    gitState.branch
  )};const timestamp=${JSON.stringify(
    new Date().toISOString()
  )};const pattern=new RegExp(${JSON.stringify(
    TASK_LINE_PATTERN.source
  )});const parse=(content)=>content.split(/\\r?\\n/).map((text,index)=>{const match=pattern.exec(text);return match?{id:match[4],done:match[2].toLowerCase()==="x",index,text}:null}).filter(Boolean);const entries=[];for(const path of paths){const file=app.vault.getAbstractFileByPath(path);if(!file)throw new Error("Plan file not found: "+path);const content=await app.vault.cachedRead(file);const tasks=parse(content);if(tasks.filter(task=>task.id===taskId).length!==1)throw new Error(path+": expected exactly one "+taskId);entries.push({file,path,content,tasks})}const ids=entries.map(entry=>entry.tasks.map(task=>task.id).join("\\n"));const states=entries.map(entry=>entry.tasks.map(task=>String(task.done)).join("\\n"));if(new Set(ids).size!==1)throw new Error("Bilingual task ID order differs");if(new Set(states).size!==1)throw new Error("Bilingual task completion differs before update");const targetDone=entries[0].tasks.find(task=>task.id===taskId).done;if(targetDone===done)return JSON.stringify({changed:false,paths,taskId,done,commit,branch});try{for(const entry of entries){const lines=entry.content.split(/\\r?\\n/);const task=entry.tasks.find(candidate=>candidate.id===taskId);lines[task.index]=lines[task.index].replace(/^(\\s*-\\s+\\[)[ xX](\\])/,"$1"+(done?"x":" ")+"$2");await app.vault.modify(entry.file,lines.join("\\n"))}for(const entry of entries){const content=await app.vault.cachedRead(entry.file);const tasks=parse(content);const completed=tasks.filter(task=>task.done).length;const total=tasks.length;const next=tasks.find(task=>!task.done)?.id;const status=completed===0?"not-started":completed===total?"verification":"in-progress";await app.fileManager.processFrontMatter(entry.file,fm=>{fm.progress_completed=completed;fm.progress_total=total;fm.implementation_status=status;fm.last_progress_at=timestamp;fm.last_progress_head=commit;fm.work_branch=branch;if(next)fm.current_task=next;else delete fm.current_task;if(done){const commits=Array.isArray(fm.implementation_commits)?fm.implementation_commits:fm.implementation_commits?[String(fm.implementation_commits)]:[];if(!commits.includes(commit))commits.push(commit);fm.implementation_commits=commits}})}return JSON.stringify({changed:true,paths,taskId,done,commit,branch})}catch(error){for(const entry of entries){await app.vault.modify(entry.file,entry.content)}throw error}})()`
  return evaluateObsidian(config, code)
}
