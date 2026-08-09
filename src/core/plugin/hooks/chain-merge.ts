import { bandIndex, type RoleBand } from './role-band'
import type { StagedHttpPatch } from './staged-effects'

interface ChainEntry {
  pluginId: string
  role: RoleBand
  patch: StagedHttpPatch
}

export interface MergedHttp {
  uris: string[]
  filename?: string
  connections?: number
  headers: { name: string; value: string }[]
  proxy?: string
  contributors: {
    headers: string[]
    proxy?: string
    uris?: string
  }
}

export function mergeChain(
  userInput: {
    uris: string[]
    filename?: string
    connections?: number
    headers: { name: string; value: string }[]
    proxy?: string
  },
  plugins: ReadonlyArray<ChainEntry>
): MergedHttp {
  const sorted = [...plugins].sort((a, b) => {
    const d = bandIndex(a.role) - bandIndex(b.role)
    return d !== 0 ? d : a.pluginId.localeCompare(b.pluginId)
  })

  const userNamesLC = new Set(
    userInput.headers.map((h) => h.name.toLowerCase())
  )
  const headers = [...userInput.headers]
  const headerContributors: string[] = []

  let uris = userInput.uris
  let filename = userInput.filename
  let connections = userInput.connections
  let proxy = userInput.proxy
  let lastUrisFrom: string | undefined
  let proxyContributor: string | undefined

  for (const e of sorted) {
    if (e.patch.uris) {
      uris = e.patch.uris
      lastUrisFrom = e.pluginId
    }
    if (e.patch.filename) filename = e.patch.filename
    if (e.patch.connections) connections = e.patch.connections

    if (e.patch.headers) {
      for (const h of e.patch.headers) {
        const lc = h.name.toLowerCase()
        if (userNamesLC.has(lc)) continue
        const idx = headers.findIndex((x) => x.name.toLowerCase() === lc)
        if (idx >= 0) {
          headers[idx] = h
        } else {
          headers.push(h)
        }
        if (!headerContributors.includes(e.pluginId)) {
          headerContributors.push(e.pluginId)
        }
      }
    }

    if (e.patch.proxy && !userInput.proxy) {
      proxy = e.patch.proxy
      proxyContributor = e.pluginId
    }
  }

  return {
    uris,
    filename,
    connections,
    headers,
    proxy,
    contributors: {
      headers: headerContributors,
      proxy: proxyContributor,
      uris: lastUrisFrom,
    },
  }
}
