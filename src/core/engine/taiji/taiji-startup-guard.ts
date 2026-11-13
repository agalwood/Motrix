import { z } from 'zod'
import { isNotFoundError } from '../aria2/error-utils'
import type {
  EngineStartupGuard,
  PreparedEngineStartup,
} from '../engine-startup-guard'
import type { TaijiRpcClient } from './taiji-rpc-client'

const startupTasks = z.array(
  z.tuple([z.string().regex(/^[0-9a-f]{16}$/), z.boolean()])
)

/** The engine holds all restored queues before any payload work can begin. */
export class TaijiStartupGuard implements EngineStartupGuard {
  constructor(
    private readonly deps: {
      completedGids: () => ReadonlySet<string>
      heldGids?: () => ReadonlySet<string>
      authorizeResume?: (gid: string) => Promise<boolean>
      rpc: Pick<
        TaijiRpcClient,
        'getGlobalOption' | 'tellStatus' | 'forceRemove' | 'changeGlobalOption'
      >
      removeResult: (gid: string) => Promise<void>
    }
  ) {}

  async prepare(args: readonly string[]): Promise<PreparedEngineStartup> {
    return {
      args: [...args],
      reconcile: async (isStopping) => {
        const options = await this.deps.rpc.getGlobalOption()
        const tasks = startupTasks.parse(
          JSON.parse(options['motrix-startup-tasks'] ?? 'null')
        )
        const release: string[] = []
        for (const [gid, resume] of tasks) {
          if (isStopping()) return
          if (this.deps.heldGids?.().has(gid)) continue
          if (this.deps.completedGids().has(gid)) {
            let state: string | undefined
            try {
              state = (await this.deps.rpc.tellStatus(gid)).status
            } catch (error) {
              if (!isNotFoundError(error)) throw error
            }
            if (isStopping()) return
            if (
              this.deps.heldGids?.().has(gid) ||
              !this.deps.completedGids().has(gid)
            )
              continue
            if (state && !['complete', 'error', 'removed'].includes(state))
              await this.deps.rpc.forceRemove(gid)
            if (isStopping()) return
            if (!this.deps.heldGids?.().has(gid))
              await this.deps.removeResult(gid)
          } else if (
            resume &&
            (!this.deps.authorizeResume ||
              (await this.deps.authorizeResume(gid)))
          ) {
            release.push(gid)
          }
        }
        if (isStopping()) return
        // Release only after every required cleanup succeeds. Holdings do not
        // rewrite persisted run intent, so a crash during reconciliation is retryable.
        for (let offset = 0; offset < release.length; offset += 1000) {
          if (isStopping()) return
          const current = release
            .slice(offset, offset + 1000)
            .filter(
              (gid) =>
                !this.deps.completedGids().has(gid) &&
                !this.deps.heldGids?.().has(gid)
            )
          await this.deps.rpc.changeGlobalOption({
            'motrix-release-startup': JSON.stringify(current),
          })
        }
      },
    }
  }
}
