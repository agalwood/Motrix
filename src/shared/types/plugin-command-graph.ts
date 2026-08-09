export interface PluginCommandGraphEdge {
  sourcePluginId: string
  targetPluginId: string
  commandId: string
  calls: number
  lastCalledAt: number
}

export interface PluginCommandGraphDTO {
  edges: PluginCommandGraphEdge[]
  cutoff: number
  generatedAt: number
  truncated: boolean
}
