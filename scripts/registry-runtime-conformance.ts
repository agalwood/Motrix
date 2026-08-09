import {
  RegistryFileSchema,
  resolveRegistryListing,
} from '../src/shared/schemas/registry'
import conformance from '../src/shared/schemas/registry.conformance.json'

type PathPart = string | number

interface CorpusOperation {
  op: 'set' | 'delete' | 'appendCopy'
  path: PathPart[]
  from?: PathPart[]
  value?: unknown
}

export interface RegistryRuntimeConformanceResult {
  totalCases: number
  wireCasesPassed: number
  preservedPaths: number
  preservedPathsPassed: number
  resolverCases: number
  resolverCasesPassed: number
}

function atPath(root: unknown, parts: PathPart[]): unknown {
  let value = root
  for (const part of parts) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<PropertyKey, unknown>)[part]
  }
  return value
}

function materializeCase(operations: CorpusOperation[]): unknown {
  const result: unknown = structuredClone(conformance.baseFile)
  for (const operation of operations) {
    if (operation.op === 'appendCopy') {
      const target = atPath(result, operation.path)
      if (!Array.isArray(target)) throw new Error('invalid appendCopy target')
      target.push(structuredClone(atPath(result, operation.from ?? [])))
      continue
    }

    const parent = atPath(result, operation.path.slice(0, -1))
    if (typeof parent !== 'object' || parent === null) {
      throw new Error('invalid conformance operation path')
    }
    const key = operation.path.at(-1)
    if (key === undefined) throw new Error('empty conformance operation path')
    const target = parent as Record<PropertyKey, unknown>
    if (operation.op === 'delete') delete target[key]
    else target[key] = structuredClone(operation.value)
  }
  return result
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    )
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        deepEqual(leftRecord[key], rightRecord[key])
    )
  )
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    )
  }
}

/** Runs the vendored shared corpus against the production App resolver. */
export function runRegistryRuntimeConformance(): RegistryRuntimeConformanceResult {
  let wireCasesPassed = 0
  let preservedPaths = 0
  let preservedPathsPassed = 0
  let resolverCases = 0
  let resolverCasesPassed = 0

  for (const corpusCase of conformance.cases) {
    const input = materializeCase(corpusCase.operations as CorpusOperation[])
    const wire = RegistryFileSchema.safeParse(input)
    assertEqual(
      wire.success,
      corpusCase.wireExpected.accepted,
      `${corpusCase.id} wire acceptance`
    )
    wireCasesPassed += 1
    if (!wire.success) continue

    for (const preserved of corpusCase.wireExpected.preservedPaths ?? []) {
      preservedPaths += 1
      assertEqual(
        atPath(wire.data, preserved as PathPart[]),
        atPath(input, preserved as PathPart[]),
        `${corpusCase.id} preserved path ${preserved.join('.')}`
      )
      preservedPathsPassed += 1
    }

    if (!corpusCase.resolverExpected) continue
    resolverCases += 1
    const plugin = wire.data.plugins.find(
      (entry) => entry.id === corpusCase.resolverExpected?.pluginId
    )
    if (!plugin) throw new Error(`${corpusCase.id} plugin not found`)
    assertEqual(
      resolveRegistryListing(
        plugin.listing,
        corpusCase.resolverExpected.requestedLocale
      ),
      corpusCase.resolverExpected.resolved,
      `${corpusCase.id} resolver result`
    )
    resolverCasesPassed += 1
  }

  return {
    totalCases: conformance.cases.length,
    wireCasesPassed,
    preservedPaths,
    preservedPathsPassed,
    resolverCases,
    resolverCasesPassed,
  }
}
