#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkActivePlans,
  clearLocalContext,
  createDocument,
  getGitState,
  listDocuments,
  loadDocsConfig,
  planSummary,
  readPlanBundle,
  resolvePlanReference,
  runObsidian,
  updatePlanTask,
  writeLocalContext,
} from './obsidian-docs-lib.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

export function parseArguments(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const key = argument.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = value
      index += 1
    }
  }
  return { options, positional }
}

function printHelp() {
  console.log(`Motrix Obsidian documentation gateway

Optional maintainer tooling. Copy obsidian-docs.config.example.json to the
ignored obsidian-docs.config.json and customize it before using vault commands.

Usage:
  pnpm run docs:doctor
  pnpm run docs:create -- <directory> <path.md> [--from <file> | --stdin] [--overwrite]
  pnpm run docs:list -- plans|specs [--all] [--include-indexes]
  pnpm run docs:use -- <plan-id>
  pnpm run docs:clear
  pnpm run docs:context -- [plan-id] [--format json]
  pnpm run docs:status -- [plan-id] [--format json]
  pnpm run docs:task -- done <task-id> [plan-id] --commit <git-ref>
  pnpm run docs:task -- todo <task-id> [plan-id]
  pnpm run docs:check -- [--format json]

Create directories:
  specs, plans, decisions, evidence, publication, archive-plans, legacy-import
`)
}

function requireValue(value, label) {
  if (!value) throw new Error(`${label} is required`)
  return value
}

function readCreateContent(options) {
  const hasFile = options.from !== undefined
  const hasStdin = options.stdin !== undefined
  if (hasFile && hasStdin) {
    throw new Error('Use only one of --from or --stdin')
  }
  if (hasFile) {
    if (typeof options.from !== 'string') {
      throw new Error('--from requires a file path')
    }
    const sourcePath = path.resolve(REPO_ROOT, options.from)
    const stats = lstatSync(sourcePath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('--from must reference a regular file, not a symlink')
    }
    return readFileSync(sourcePath, 'utf8')
  }
  if (hasStdin) {
    if (options.stdin !== true) {
      throw new Error('--stdin does not accept a value')
    }
    return readFileSync(0, 'utf8')
  }
  return ''
}

function formatDocumentTable(documents) {
  const rows = documents.map((document) => [
    document.id,
    document.language,
    document.lifecycle ?? '—',
    document.implementation_status ?? '—',
    document.path,
  ])
  return [
    ['ID', 'Lang', 'Lifecycle', 'Status', 'Path'].join('\t'),
    ...rows.map((row) => row.join('\t')),
  ].join('\n')
}

function formatContext(bundle) {
  return bundle.documents
    .map(
      (document) => `<!-- Obsidian: ${document.path} -->\n\n${document.content}`
    )
    .join('\n\n---\n\n')
}

function formatStatus(summary) {
  const lines = [
    `Plan: ${summary.id}`,
    `Path: ${summary.path}`,
    `Pair: ${summary.pairPath}`,
    `Git: ${summary.branch}@${summary.head.slice(0, 8)}`,
    `Verified head: ${summary.verifiedHead ?? '—'}`,
    `Needs revalidation: ${summary.requiresRevalidation ? 'yes' : 'no'}`,
    `Last progress head: ${summary.lastProgressHead ?? '—'}`,
    `Status: ${summary.implementationStatus ?? '—'}`,
    `Progress: ${summary.progress.completed}/${summary.progress.total}`,
    `Current task: ${summary.progress.currentTask ?? 'verification'}`,
    '',
    ...summary.tasks.map(
      (task) => `${task.done ? '[x]' : '[ ]'} ${task.id} ${task.description}`
    ),
  ]
  return lines.join('\n')
}

export function main(argv = process.argv.slice(2)) {
  const { options, positional } = parseArguments(argv)
  const [command = 'help', ...args] = positional

  if (command === 'help' || command === '--help') {
    printHelp()
    return
  }
  const config = loadDocsConfig(REPO_ROOT, options.config)
  if (command === 'create') {
    const kind = requireValue(args[0], 'document directory')
    const filename = requireValue(args[1], 'document path')
    if (args.length !== 2) {
      throw new Error('create requires a document directory and path')
    }
    if (options.overwrite !== undefined && options.overwrite !== true) {
      throw new Error('--overwrite does not accept a value')
    }
    const result = createDocument(config, {
      content: readCreateContent(options),
      filename,
      kind,
      overwrite: options.overwrite === true,
    })
    console.log(
      `${result.overwritten ? 'Overwrote' : 'Created'} ${result.path}`
    )
    return
  }
  if (command === 'doctor') {
    const version = runObsidian(config, ['version'])
    const vault = runObsidian(config, ['vault', 'info=name'])
    const projectFiles = runObsidian(config, [
      'folder',
      `path=${config.projectRoot}`,
      'info=files',
    ])
    const git = getGitState(config)
    console.log(
      [
        `Obsidian: ${version}`,
        `Vault: ${vault}`,
        `Project root: ${config.projectRoot}`,
        `Project files: ${projectFiles}`,
        `Repository: ${config.repository}`,
        `Git: ${git.branch}@${git.head.slice(0, 8)}`,
      ].join('\n')
    )
    return
  }
  if (command === 'list') {
    const kind = requireValue(args[0], 'plans or specs')
    let documents = listDocuments(config, kind)
    if (kind === 'plans' && !options['include-indexes']) {
      documents = documents.filter(
        (document) => document.document_type === 'active-plan'
      )
    }
    if (!options.all) {
      documents = documents.filter((document) => document.language === 'en')
    }
    console.log(
      options.format === 'json'
        ? JSON.stringify(documents, null, 2)
        : formatDocumentTable(documents)
    )
    return
  }
  if (command === 'use') {
    const ref = requireValue(args[0], 'plan-id')
    const bundle = readPlanBundle(config, ref)
    const plan = bundle.documents.find(
      (document) => document.path === bundle.planPath
    )
    if (!plan) throw new Error(`Plan not found in bundle: ${ref}`)
    const context = writeLocalContext(config, {
      id: plan.metadata.doc_id ?? path.basename(plan.path, '.md'),
      path: plan.path,
    })
    console.log(`Selected ${context.planId}\nContext: ${config.contextFile}`)
    return
  }
  if (command === 'clear') {
    console.log(
      clearLocalContext(config)
        ? `Cleared ${config.contextFile}`
        : `No local plan context was selected`
    )
    return
  }
  if (command === 'context') {
    const ref = resolvePlanReference(config, args[0])
    const bundle = readPlanBundle(config, ref, { includeRelated: true })
    console.log(
      options.format === 'json'
        ? JSON.stringify(bundle, null, 2)
        : formatContext(bundle)
    )
    return
  }
  if (command === 'status') {
    const ref = resolvePlanReference(config, args[0])
    const summary = planSummary(
      readPlanBundle(config, ref),
      getGitState(config)
    )
    console.log(
      options.format === 'json'
        ? JSON.stringify(summary, null, 2)
        : formatStatus(summary)
    )
    return
  }
  if (command === 'task') {
    const action = requireValue(args[0], 'task action')
    const taskId = requireValue(args[1], 'task-id')
    if (action !== 'done' && action !== 'todo') {
      throw new Error('task action must be done or todo')
    }
    if (action === 'done' && typeof options.commit !== 'string') {
      throw new Error('task done requires --commit <git-ref>')
    }
    const planRef = resolvePlanReference(config, args[2])
    const result = updatePlanTask(config, {
      commitRef: options.commit,
      done: action === 'done',
      planRef,
      taskId,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'check') {
    const result = checkActivePlans(config)
    if (options.format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(
        `Active plan pairs: ${result.pairCount}\nExecutable documents: ${result.executableDocumentCount}\nPlan indexes: ${result.indexDocumentCount}`
      )
      for (const warning of result.warnings) {
        console.warn(`WARN: ${warning}`)
      }
      for (const error of result.errors) console.error(`ERROR: ${error}`)
    }
    if (result.errors.length > 0) process.exitCode = 1
    return
  }
  throw new Error(`Unknown docs command: ${command}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
