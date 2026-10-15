import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type OperationScalar,
  validateOperationValues,
} from '@motrix/plugin-manifest-schema'
import {
  isOperationTerminal,
  type OperationDescriptor,
  type OperationDraft,
  type OperationJob,
  operationIdSchema,
  operationJobSchema,
  operationPickSchema,
  operationPrepareSchema,
  operationStartSchema,
  operationUpdateSchema,
} from '@shared/schemas/plugin-operations'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import type { CapabilityHost } from '../capabilities/interface'
import { SchemaCache } from '../commands/schema-cache'
import type { PluginHost, PluginPolicyLease } from '../host/plugin-host'
import type { PluginRegistry } from '../plugin-registry'
import { OperationFiles, operationError } from './operation-files'

export interface OperationPrincipal {
  id: string
  eligible(): boolean
}
interface Draft {
  view: OperationDraft
  selectionKey: string
  owner: OperationPrincipal
  files: OperationFiles
  check(): void
  lease: PluginPolicyLease
  busy: boolean
  disposeTimer: ReturnType<typeof setTimeout>
}
interface Job {
  view: OperationJob
  owner: string
  key: string
  fingerprint: string
  abort: AbortController
  admitted?: Promise<void>
  resourceUnsettled?: boolean
  work?: Promise<void>
  resources?: object
  output?: string
  repeat?: {
    revision: string
    args: Record<string, OperationScalar>
    inputs: { field: string; source: string; stamp: string }[]
  }
}
const FEATURES = new Set([
  'operations.v1',
  'operations.ui.v1',
  'files.selected.v1',
  'files.text.v1',
  'media.merge-streams.v1',
])
const TIMEOUT_MS = 60 * 60_000

/** Host-owned admission, authorization and result publication, shared by both shells. */
export class OperationService {
  private readonly drafts = new Map<string, Draft>()
  private readonly jobs = new Map<string, Job>()
  private shuttingDown = false
  private sweep?: ReturnType<typeof setInterval>
  constructor(
    private readonly deps: {
      registry: PluginRegistry
      host: PluginHost
      capabilities: CapabilityHost
      binary: string
      storage: string
      getTask(id: string): DownloadTask | undefined
      authorizePath?(candidate: string, mode: 'input' | 'output'): Promise<void>
    }
  ) {}

  async initialize(): Promise<void> {
    this.sweep = setInterval(() => {
      for (const [id, draft] of this.drafts)
        if (!draft.owner.eligible()) void this.releaseDraft(id)
    }, 1000)
    this.sweep.unref()
    await mkdir(this.deps.storage, { recursive: true, mode: 0o700 })
    // An incomplete native publication is never replayed. Keep its checkpoint
    // for recovery; a journal cannot prove whether an interrupted rename won.
    for (const name of (await readdir(this.deps.storage))
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .slice(-100)) {
      try {
        const saved = JSON.parse(
          await readFile(path.join(this.deps.storage, name), 'utf8')
        )
        const view = operationJobSchema.parse(saved.view)
        if (!isOperationTerminal(view.status)) {
          view.status = 'interrupted'
          view.error = 'pluginOperations.interrupted'
          view.cleanupWarning = true
        }
        this.jobs.set(view.id, { ...saved, view, abort: new AbortController() })
      } catch {
        /* Unknown journal content cannot authorize recovery or execution. */
      }
    }
  }

  catalog(): OperationDescriptor[] {
    return this.deps.registry.list().flatMap((item) => {
      const plugin = this.deps.registry.get(item.id)
      if (!plugin) return []
      return (plugin.manifest.contributes.operations?.items ?? []).flatMap(
        (definition) => {
          const command = plugin.manifest.contributes.commands?.find(
            (c) =>
              c.id === definition.command &&
              c.execution === 'operation' &&
              !c.public
          )
          if (!command?.argsSchema || !command.resultSchema) return []
          const permissions = new Set(plugin.manifest.permissions)
          const files = Object.values(definition.files ?? {})
          const blocked =
            this.deps.host.isSecurityRestricted(item.id) ||
            this.deps.host.isPolicyMutationPending(item.id) ||
            files.some(
              (file) =>
                !permissions.has(
                  file.kind === 'input-file'
                    ? 'files.selected.read'
                    : 'files.selected.write'
                )
            )
          const unavailable = !item.enabled
            ? 'disabled'
            : blocked
              ? 'blocked'
              : definition.requires?.some((feature) => !FEATURES.has(feature))
                ? 'unsupported'
                : files.some((f) => f.use === 'media') &&
                    !this.deps.capabilities.ffmpeg.available
                  ? 'ffmpeg'
                  : undefined
          return [
            {
              pluginId: item.id,
              pluginName: item.name,
              pluginVersion: item.version,
              definition,
              argsSchema: command.argsSchema,
              resultSchema: command.resultSchema,
              descriptorRevision: createHash('sha256')
                .update(
                  JSON.stringify([
                    plugin.manifestRaw,
                    this.deps.registry.policyGenerationFor(item.id),
                  ])
                )
                .digest('hex'),
              ...(unavailable ? { unavailable } : {}),
            } as OperationDescriptor,
          ]
        }
      )
    })
  }

  state(owner: OperationPrincipal) {
    this.authorize(owner)
    return {
      descriptors: this.catalog(),
      jobs: [...this.jobs.values()]
        .filter((job) => job.owner === owner.id)
        .map((job) => structuredClone(job.view)),
    }
  }
  private authorize(owner: OperationPrincipal) {
    if (this.shuttingDown || !owner.eligible()) operationError('unauthorized')
  }
  private descriptor(
    pluginId: string,
    operationId: string
  ): OperationDescriptor {
    const descriptor = this.catalog().find(
      (d) => d.pluginId === pluginId && d.definition.id === operationId
    )
    if (!descriptor || descriptor.unavailable)
      operationError(descriptor?.unavailable ?? 'unavailable')
    return descriptor
  }
  private draft(owner: OperationPrincipal, id: string): Draft {
    this.authorize(owner)
    const draft = this.drafts.get(id)
    if (
      !draft ||
      draft.owner.id !== owner.id ||
      draft.view.expiresAt <= Date.now()
    )
      operationError('draftExpired')
    draft.check()
    if (draft.busy) operationError('busy')
    return draft
  }
  async prepare(
    owner: OperationPrincipal,
    value: unknown
  ): Promise<OperationDraft> {
    this.authorize(owner)
    const request = operationPrepareSchema.parse(value)
    if (request.resume && request.repeatJobId) operationError('invalidRequest')
    const descriptor = this.descriptor(request.pluginId, request.operationId)
    const selectionKey = JSON.stringify([
      request.pluginId,
      request.operationId,
      request.taskIds ?? [],
    ])
    if (request.resume) {
      const candidates = [...this.drafts.values()]
        .filter(
          (draft) =>
            draft.owner.id === owner.id && draft.selectionKey === selectionKey
        )
        .reverse()
      // Never interrupt an in-flight selection or restore another owner's grants.
      if (candidates.some((draft) => draft.busy)) operationError('busy')
      const current = candidates.find(
        (draft) =>
          draft.view.expiresAt > Date.now() &&
          draft.view.descriptor.descriptorRevision ===
            descriptor.descriptorRevision
      )
      const obsolete = candidates.filter((draft) => draft !== current)
      if (obsolete.length) {
        await Promise.all(
          obsolete.map((draft) => this.releaseDraft(draft.view.id))
        )
        // Re-check after cleanup; another request may have created a draft.
        if (!current) return this.prepare(owner, value)
      }
      if (current)
        return structuredClone(this.draft(owner, current.view.id).view)
    }
    if (
      this.drafts.size >= 16 ||
      [...this.drafts.values()].filter((d) => d.owner.id === owner.id).length >=
        4
    )
      operationError('resourceLimit')
    const previous = request.repeatJobId
      ? this.jobs.get(request.repeatJobId)
      : undefined
    if (
      request.repeatJobId &&
      (!previous ||
        previous.owner !== owner.id ||
        !isOperationTerminal(previous.view.status) ||
        previous.resourceUnsettled ||
        previous.view.pluginId !== request.pluginId ||
        previous.view.operationId !== request.operationId ||
        previous.repeat?.revision !== descriptor.descriptorRevision ||
        (descriptor.definition.ui?.repeat !== 'preserve-inputs' &&
          descriptor.definition.ui?.repeat !== 'preserve-options'))
    )
      operationError('invalidRequest')
    const check = this.deps.host.capturePolicyCheck(request.pluginId)
    const lease = this.deps.host.acquirePolicyLease(
      request.pluginId,
      this.deps.registry.policyGenerationFor(request.pluginId)
    )
    const files = new OperationFiles({
      binary: this.deps.binary,
      storage: path.join(this.deps.storage, 'files'),
      definition: descriptor.definition,
      ffmpeg: this.deps.capabilities.ffmpeg,
      authorizePath: this.deps.authorizePath,
      assertAllowed: () => {
        this.authorize(owner)
        check()
        lease.signal.throwIfAborted()
      },
    })
    const id = randomUUID()
    const view: OperationDraft = {
      id,
      descriptor,
      args: validateOperationValues(descriptor.argsSchema, {}).value,
      files: {},
      expiresAt: Date.now() + 15 * 60_000,
    }
    const timer = setTimeout(() => {
      void this.releaseDraft(id)
    }, 15 * 60_000)
    timer.unref()
    const draft: Draft = {
      view,
      selectionKey,
      owner,
      files,
      check,
      lease,
      busy: true,
      disposeTimer: timer,
    }
    this.drafts.set(id, draft)
    lease.signal.addEventListener(
      'abort',
      () => {
        if (this.drafts.has(id)) void this.releaseDraft(id)
      },
      { once: true }
    )
    try {
      if (previous?.repeat) {
        view.args = { ...previous.repeat.args }
        for (const input of previous.repeat.inputs)
          await files.restoreInput(input, view.args)
        for (const [field, grant] of Object.entries(files.views()))
          view.args[field] = grant.ref
      } else if (request.taskIds?.length) {
        const entry = descriptor.definition.entries.find(
          (e) => e.surface === 'task-menu'
        )
        if (
          entry?.surface !== 'task-menu' ||
          new Set(request.taskIds).size !== request.taskIds.length ||
          request.taskIds.length < entry.selection.count.min ||
          request.taskIds.length > entry.selection.count.max
        )
          operationError('invalidSelection')
        const tasks = request.taskIds.map((id) => this.deps.getTask(id))
        if (
          tasks.some(
            (task) =>
              !task ||
              task.status !== TaskStatus.Completed ||
              task.fileCount > 1 ||
              !task.finalPath
          )
        )
          operationError('invalidSelection')
        for (const [field, binding] of Object.entries(entry.bind)) {
          const task = tasks[binding.index]
          if (!task?.finalPath) operationError('invalidSelection')
          const grant = await files.pick(field, task.finalPath, view.args)
          view.args[field] = grant.ref
        }
      }
      view.files = files.views()
      view.suggestions = previous ? {} : files.suggestions(view.args)
      draft.busy = false
      return structuredClone(view)
    } catch (error) {
      await this.releaseDraft(id)
      throw error
    }
  }
  selectionIdentity(owner: OperationPrincipal, value: unknown): string {
    const request = operationPickSchema.parse(value)
    const { descriptor } = this.draft(owner, request.draftId).view
    return `${descriptor.pluginId} / ${descriptor.definition.id}`
  }
  picker(owner: OperationPrincipal, value: unknown) {
    const request = operationPickSchema.parse(value)
    const draft = this.draft(owner, request.draftId)
    this.scalarValues(draft, request.values)
    return draft.files.picker(request.field, request.values)
  }
  async update(
    owner: OperationPrincipal,
    value: unknown
  ): Promise<OperationDraft> {
    const request = operationUpdateSchema.parse(value)
    const draft = this.draft(owner, request.draftId)
    draft.busy = true
    try {
      this.scalarValues(draft, request.values)
      await draft.files.synchronize(request.values)
      return this.refresh(draft, request.values)
    } finally {
      draft.busy = false
    }
  }
  private scalarValues(draft: Draft, values: Record<string, OperationScalar>) {
    const checked = validateOperationValues(
      draft.view.descriptor.argsSchema,
      values
    )
    if (
      Object.entries(checked.errors).some(
        ([key, error]) =>
          error !== 'required' && !draft.view.descriptor.definition.files?.[key]
      )
    )
      operationError('invalidRequest')
  }
  private refresh(
    draft: Draft,
    values: Record<string, OperationScalar>
  ): OperationDraft {
    draft.check()
    draft.view.files = draft.files.views()
    draft.view.args = { ...values }
    for (const field of Object.keys(
      draft.view.descriptor.definition.files ?? {}
    )) {
      delete draft.view.args[field]
      if (draft.view.files[field])
        draft.view.args[field] = draft.view.files[field].ref
    }
    draft.view.suggestions = draft.files.suggestions(draft.view.args)
    return structuredClone(draft.view)
  }
  async pick(
    owner: OperationPrincipal,
    value: unknown
  ): Promise<OperationDraft> {
    const request = operationPickSchema.parse(value)
    const draft = this.draft(owner, request.draftId)
    if (!request.candidate) operationError('invalidFile')
    draft.busy = true
    try {
      const binding = draft.view.descriptor.definition.files?.[request.field]
      if (binding?.kind === 'output-file' && binding.extensionFrom) {
        const extension = path.extname(request.candidate).slice(1).toLowerCase()
        if (
          draft.view.descriptor.argsSchema.properties?.[
            binding.extensionFrom
          ]?.enum?.includes(extension)
        )
          request.values[binding.extensionFrom] = extension
      }
      this.scalarValues(draft, request.values)
      await draft.files.synchronize(request.values)
      await draft.files.pick(request.field, request.candidate, request.values)
      return this.refresh(draft, request.values)
    } finally {
      draft.busy = false
    }
  }
  async discard(owner: OperationPrincipal, value: unknown): Promise<void> {
    this.draft(owner, operationIdSchema.parse(value))
    await this.releaseDraft(String(value))
  }
  private async releaseDraft(id: string) {
    const draft = this.drafts.get(id)
    if (!draft) return
    this.drafts.delete(id)
    clearTimeout(draft.disposeTimer)
    draft.files.seal()
    await draft.files.cleanup().catch(() => undefined)
    draft.lease.release()
  }
  get(owner: OperationPrincipal, value: unknown): OperationJob {
    this.authorize(owner)
    const job = this.jobs.get(operationIdSchema.parse(value))
    if (!job || job.owner !== owner.id) operationError('jobMissing')
    return structuredClone(job.view)
  }
  cancel(owner: OperationPrincipal, value: unknown): OperationJob {
    const view = this.get(owner, value)
    const job = this.jobs.get(view.id)
    if (
      job &&
      !isOperationTerminal(view.status) &&
      !['committing', 'cleaning'].includes(view.status)
    ) {
      this.transition(job, 'cancelling')
      job.abort.abort()
    }
    return this.get(owner, value)
  }
  output(owner: OperationPrincipal, id: string): string {
    const view = this.get(owner, id)
    const job = this.jobs.get(view.id)
    if (view.status !== 'succeeded' || !job?.output)
      operationError('invalidOutput')
    return job.output
  }
  async start(
    owner: OperationPrincipal,
    value: unknown
  ): Promise<OperationJob> {
    this.authorize(owner)
    const request = operationStartSchema.parse(value)
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex')
    const duplicate = [...this.jobs.values()].find(
      (job) => job.owner === owner.id && job.key === request.idempotencyKey
    )
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint)
        operationError('invalidRequest')
      await duplicate.admitted
      return structuredClone(duplicate.view)
    }
    const draft = this.draft(owner, request.draftId)
    const descriptor = this.descriptor(
      draft.view.descriptor.pluginId,
      draft.view.descriptor.definition.id
    )
    if (
      descriptor.descriptorRevision !== request.descriptorRevision ||
      descriptor.descriptorRevision !== draft.view.descriptor.descriptorRevision
    )
      operationError('descriptorChanged')
    const active = [...this.jobs.values()].filter(
      (job) => !isOperationTerminal(job.view.status) || job.resourceUnsettled
    )
    if (
      active.length >= 2 ||
      active.some((job) => job.view.pluginId === descriptor.pluginId)
    )
      operationError('busy')
    const args = validateOperationValues(descriptor.argsSchema, request.args)
    if (Object.keys(args.errors).length) operationError('invalidRequest')
    draft.files.validate(args.value)
    const schemas = new SchemaCache('operation')
    schemas.installCommandSchemas(
      descriptor.pluginId,
      this.deps.registry.get(descriptor.pluginId)?.manifest.contributes
        .commands ?? []
    )
    schemas.validateArgs(
      descriptor.pluginId,
      descriptor.definition.command,
      args.value
    )
    const id = randomUUID()
    const now = Date.now()
    const job: Job = {
      owner: owner.id,
      key: request.idempotencyKey,
      fingerprint,
      ...(descriptor.definition.ui?.repeat === 'preserve-inputs' ||
      descriptor.definition.ui?.repeat === 'preserve-options'
        ? {
            repeat: {
              revision: descriptor.descriptorRevision,
              args: Object.fromEntries(
                Object.entries(args.value).filter(
                  ([field]) => !descriptor.definition.files?.[field]
                )
              ),
              inputs:
                descriptor.definition.ui?.repeat === 'preserve-inputs'
                  ? draft.files.repeatInputs()
                  : [],
            },
          }
        : {}),
      abort: new AbortController(),
      view: {
        id,
        pluginId: descriptor.pluginId,
        operationId: descriptor.definition.id,
        pluginName: descriptor.pluginName,
        title: descriptor.definition.title,
        status: 'accepted',
        percent: null,
        sequence: 0,
        createdAt: now,
        updatedAt: now,
        outputs: [],
      },
    }
    this.jobs.set(id, job)
    this.drafts.delete(draft.view.id)
    clearTimeout(draft.disposeTimer)
    try {
      job.admitted = this.persist(job)
      await job.admitted
    } catch (error) {
      this.jobs.delete(id)
      draft.lease.release()
      await draft.files.cleanup()
      throw error
    }
    job.work = this.run(job, draft, args.value, schemas)
    void job.work.catch(() => undefined)
    return structuredClone(job.view)
  }
  private transition(job: Job, status: OperationJob['status']) {
    job.view.status = status
    job.view.sequence++
    job.view.updatedAt = Date.now()
  }
  private async persist(job: Job) {
    const destination = path.join(this.deps.storage, `${job.view.id}.json`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(
        JSON.stringify({
          view: job.view,
          owner: job.owner,
          key: job.key,
          fingerprint: job.fingerprint,
          resources: job.resources,
          output: job.output,
        })
      )
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, destination)
    // POSIX directory durability; unsupported directory flushing is fatal on POSIX.
    if (process.platform !== 'win32') {
      const directory = await open(this.deps.storage, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  }
  private async run(
    job: Job,
    draft: Draft,
    args: Record<string, OperationScalar>,
    schemas: SchemaCache
  ) {
    const signal = AbortSignal.any([job.abort.signal, draft.lease.signal])
    const timeout = setTimeout(
      () => job.abort.abort(new Error('timeout')),
      Object.values(draft.view.descriptor.definition.files ?? {}).some(
        (file) => file.use === 'media'
      )
        ? TIMEOUT_MS
        : 60_000
    )
    timeout.unref()
    const checkOwner = setInterval(() => {
      if (!draft.owner.eligible()) job.abort.abort()
    }, 1000)
    checkOwner.unref()
    let committed = false
    const abort = () => {
      if (!committed) draft.files.seal()
    }
    signal.addEventListener('abort', abort, { once: true })
    const log = (status: string) => {
      try {
        this.deps.capabilities
          .createLog(job.view.pluginId)
          .info('Plugin operation state', {
            jobId: job.view.id,
            operationId: job.view.operationId,
            status,
            error: job.view.error,
            cleanupWarning: job.view.cleanupWarning,
          })
      } catch {
        /* Logging never changes ownership. */
      }
    }
    let terminal: 'succeeded' | 'failed' | 'cancelled' = 'failed'
    try {
      signal.throwIfAborted()
      this.transition(job, 'preparing')
      log('preparing')
      await this.persist(job)
      await draft.files.prepare(async (resources) => {
        job.resources = resources
        await this.persist(job)
      })
      signal.throwIfAborted()
      await this.deps.host.activate(job.view.pluginId)
      signal.throwIfAborted()
      this.transition(job, 'running')
      await this.persist(job)
      let lastProgress = 0
      const context = draft.files.execution(job.view.id, signal, (percent) => {
        if (Date.now() - lastProgress >= 250) {
          job.view.percent = percent
          job.view.sequence++
          job.view.updatedAt = Date.now()
          lastProgress = Date.now()
        }
      })
      const result = await this.deps.host.invokeCommand(
        job.view.pluginId,
        draft.view.descriptor.definition.command,
        args,
        { operation: context }
      )
      this.transition(job, 'validating')
      schemas.validateResult(
        job.view.pluginId,
        draft.view.descriptor.definition.command,
        result
      )
      const output = await draft.files.validateOutput(
        result as Record<string, unknown>,
        signal
      )
      if (output)
        await draft.files.stageOutput(output, async (resources) => {
          job.resources = resources
          await this.persist(job)
        })
      signal.throwIfAborted()
      draft.check()
      this.authorize(draft.owner)
      this.transition(job, 'committing')
      await this.persist(job)
      // Authorization linearizes here. Late cancellation cannot delete a published result.
      signal.throwIfAborted()
      draft.check()
      committed = true
      if (output) {
        job.output = await draft.files.publish(output)
        job.view.outputs = [
          {
            id: randomUUID(),
            name: path.basename(job.output),
            location: job.output,
          },
        ]
      }
      job.view.result = Object.fromEntries(
        Object.entries(result as Record<string, OperationScalar>).filter(
          ([field]) =>
            draft.view.descriptor.definition.result?.fields?.includes(field)
        )
      )
      terminal = 'succeeded'
      job.view.percent = 100
    } catch (error) {
      terminal =
        !committed && (signal.aborted || !draft.owner.eligible())
          ? 'cancelled'
          : 'failed'
      const message = error instanceof Error ? error.message : ''
      const business = /^operation\.error\.([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(
        message
      )?.[1]
      job.view.error =
        terminal === 'cancelled'
          ? undefined
          : business && draft.view.descriptor.definition.errors?.[business]
            ? `operation.error.${business}`
            : /^pluginOperations\.[A-Za-z]+$/.test(message) ||
                /^plugin\.runtime\.ffmpeg(?:Unavailable|Incompatible)$/.test(
                  message
                )
              ? message
              : committed
                ? 'pluginOperations.publicationUncertain'
                : 'pluginOperations.failed'
      if (!committed) {
        job.abort.abort()
        draft.files.seal()
      }
    } finally {
      clearTimeout(timeout)
      clearInterval(checkOwner)
      signal.removeEventListener('abort', abort)
      this.transition(job, 'cleaning')
      try {
        job.view.cleanupWarning = !(await draft.files.cleanup())
      } catch {
        job.view.cleanupWarning = true
        job.resourceUnsettled = true
      }
      draft.lease.release()
      this.transition(job, terminal)
      log(terminal)
      await this.persist(job).catch(() => {
        job.view.cleanupWarning = true
      })
      const completed = [...this.jobs.values()].filter(
        (j) => isOperationTerminal(j.view.status) && !j.view.cleanupWarning
      )
      for (const old of completed.slice(
        0,
        Math.max(0, completed.length - 50)
      )) {
        this.jobs.delete(old.view.id)
        await rm(path.join(this.deps.storage, `${old.view.id}.json`), {
          force: true,
        })
      }
    }
  }
  async shutdown() {
    this.shuttingDown = true
    clearInterval(this.sweep)
    for (const job of this.jobs.values())
      if (!['committing', 'cleaning'].includes(job.view.status))
        job.abort.abort()
    await Promise.all(
      [...this.drafts.keys()].map((id) => this.releaseDraft(id))
    )
    await Promise.allSettled([...this.jobs.values()].map((job) => job.work))
  }
}
