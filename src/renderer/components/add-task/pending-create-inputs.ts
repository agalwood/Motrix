import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'

const storageKey = 'motrix.pending-create-inputs.v1'
const pendingInputSchema = z.object({
  id: z.uuid(),
  identity: z.string().regex(/^[0-9a-f]{64}$/),
})
export type PendingCreateInput = z.infer<typeof pendingInputSchema>

/** Keep only opaque receipts, never URLs, headers, cookies or proxy credentials. */
export function createInputIdentity(request: unknown): string {
  return Array.from(
    sha256(new TextEncoder().encode(JSON.stringify(request))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}

export function readPendingCreates(): PendingCreateInput[] {
  try {
    const parsed = z
      .array(pendingInputSchema)
      .safeParse(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function rememberPendingCreate(input: PendingCreateInput): void {
  savePendingCreates([
    ...readPendingCreates().filter((entry) => entry.id !== input.id),
    input,
  ])
}

export function forgetPendingCreate(id: string): void {
  savePendingCreates(readPendingCreates().filter((entry) => entry.id !== id))
}

function savePendingCreates(inputs: PendingCreateInput[]): void {
  try {
    if (inputs.length) localStorage.setItem(storageKey, JSON.stringify(inputs))
    else localStorage.removeItem(storageKey)
  } catch {
    // The live draft still retains its IDs when browser storage is unavailable.
  }
}
