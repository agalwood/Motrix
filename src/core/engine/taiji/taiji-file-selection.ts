import { z } from 'zod'

const selectionSchema = z
  .string()
  .regex(/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/)
const filesSchema = z.array(
  z.object({
    index: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number),
    padding: z.enum(['true', 'false']).default('false'),
  })
)

/** Motrix/aria2 indices include pad entries; taiji selection excludes them. */
export function toTaijiSelection(
  selection: string,
  padding: readonly boolean[]
): string {
  selectionSchema.parse(selection)
  const selected = new Set<number>()
  for (const part of selection.split(',')) {
    const [first, last = first] = part.split('-').map(Number)
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      last < first ||
      last > padding.length
    )
      throw new TypeError('Invalid torrent file selection')
    for (let index = first; index <= last; index++) selected.add(index)
  }
  let native = 0
  const mapped: number[] = []
  padding.forEach((pad, index) => {
    if (!pad) {
      native++
      if (selected.has(index + 1)) mapped.push(native)
    }
  })
  if (!mapped.length)
    throw new TypeError('Select at least one torrent payload file')
  return mapped.join(',')
}

export function taijiFilePadding(files: unknown): boolean[] {
  const parsed = filesSchema.parse(files)
  if (parsed.some((file, index) => file.index !== index + 1))
    throw new TypeError('Unexpected torrent file order')
  return parsed.map((file) => file.padding === 'true')
}
