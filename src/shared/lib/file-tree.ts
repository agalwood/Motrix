import type { BaseFileRow } from '@shared/types/file-row'

export interface FileTreeNode {
  key: string
  name: string
  /** Source position, never the engine's file index. -1 denotes a folder. */
  source: number
  parent: number
  depth: number
  position: number
  siblings: number
  /** Half-open range in leaves; folders never copy descendant arrays. */
  start: number
  end: number
  /** First node after this entire subtree in the preorder array. */
  next: number
}

export interface FileTree {
  source: readonly BaseFileRow[]
  hierarchical: boolean
  nodes: FileTreeNode[]
  leaves: number[]
  sizes: Float64Array
  folders: number
}

interface Branch {
  node: FileTreeNode
  folders: Map<string, Branch>
  files: FileTreeNode[]
}

/** Yields bounded batches so the renderer can build large manifests cooperatively. */
export function* createFileTree(
  files: readonly BaseFileRow[],
  hierarchical = true
): Generator<void, FileTree> {
  const makeNode = (key: string, name: string, source = -1): FileTreeNode => ({
    key,
    name,
    source,
    parent: -1,
    depth: 0,
    position: 0,
    siblings: 0,
    start: 0,
    end: 0,
    next: 0,
  })
  const root: Branch = { node: makeNode('', ''), folders: new Map(), files: [] }
  let folders = 0
  for (let source = 0; source < files.length; source++) {
    const file = files[source]
    if (!file.padding) {
      const parts = hierarchical
        ? file.path.split(/[/\\]/).filter(Boolean)
        : [file.path]
      let branch = root
      let path = ''
      for (let i = 0; i < parts.length - 1; i++) {
        path += `${parts[i]}/`
        let child = branch.folders.get(parts[i])
        if (!child) {
          child = {
            node: makeNode(`d:${path}`, parts[i]),
            folders: new Map(),
            files: [],
          }
          branch.folders.set(parts[i], child)
          folders++
        }
        branch = child
      }
      branch.files.push(
        makeNode(`f:${file.index}`, parts.at(-1) || file.path, source)
      )
    }
    if ((source & 255) === 255) yield
  }

  const nodes: FileTreeNode[] = []
  const leaves: number[] = []
  // Iterators avoid recursive stack overflow and a second full flattened copy.
  const stack = [
    {
      branch: root,
      children: root.folders.values(),
      file: 0,
      id: -1,
      position: 0,
    },
  ]
  let steps = 0
  while (stack.length) {
    const frame = stack[stack.length - 1]
    const child = frame.children.next().value as Branch | undefined
    const node = child?.node ?? frame.branch.files[frame.file++]
    if (!node) {
      frame.branch.node.end = leaves.length
      frame.branch.node.next = nodes.length
      stack.pop()
      continue
    }
    node.parent = frame.id
    node.depth = stack.length - 1
    node.position = ++frame.position
    node.siblings = frame.branch.folders.size + frame.branch.files.length
    node.start = leaves.length
    const id = nodes.push(node) - 1
    if (child) {
      stack.push({
        branch: child,
        children: child.folders.values(),
        file: 0,
        id,
        position: 0,
      })
    } else {
      leaves.push(node.source)
      node.end = leaves.length
      node.next = nodes.length
    }
    if ((++steps & 255) === 0) yield
  }
  const sizes = new Float64Array(leaves.length + 1)
  for (let i = 0; i < leaves.length; i++) {
    sizes[i + 1] = sizes[i] + files[leaves[i]].size
    if ((i & 1023) === 1023) yield
  }
  return { source: files, hierarchical, nodes, leaves, sizes, folders }
}

export function buildFileTree(
  files: readonly BaseFileRow[],
  hierarchical = true
): FileTree {
  const builder = createFileTree(files, hierarchical)
  let result = builder.next()
  while (!result.done) result = builder.next()
  return result.value
}

/** Progress snapshots reuse topology, file names and directory size sums. */
export function hasFileTreeStructure(
  tree: FileTree,
  files: readonly BaseFileRow[],
  hierarchical: boolean
): boolean {
  if (tree.hierarchical !== hierarchical || tree.source.length !== files.length)
    return false
  if (tree.source === files) return true
  return files.every((file, i) => {
    const previous = tree.source[i]
    return (
      file.index === previous.index &&
      file.path === previous.path &&
      file.size === previous.size &&
      !!file.padding === !!previous.padding
    )
  })
}

export function fileTreeSelection(
  tree: FileTree,
  selected: ReadonlySet<number>
) {
  const counts = new Uint32Array(tree.leaves.length + 1)
  let size = 0
  for (let i = 0; i < tree.leaves.length; i++) {
    const file = tree.source[tree.leaves[i]]
    const included = selected.has(file.index)
    counts[i + 1] = counts[i] + Number(included)
    if (included) size += file.size
  }
  return { counts, size }
}

export function fileTreeMatches(
  tree: FileTree,
  query: string
): Uint32Array | undefined {
  const needle = query.trim().toLowerCase()
  if (!needle) return undefined
  const counts = new Uint32Array(tree.leaves.length + 1)
  for (let i = 0; i < tree.leaves.length; i++) {
    const match = tree.source[tree.leaves[i]].path
      .toLowerCase()
      .includes(needle)
    counts[i + 1] = counts[i] + Number(match)
  }
  return counts
}

export function visibleFileTree(
  tree: FileTree,
  expanded: (node: FileTreeNode) => boolean,
  matches?: Uint32Array
): number[] {
  const visible: number[] = []
  for (let id = 0; id < tree.nodes.length; ) {
    const node = tree.nodes[id]
    if (matches && matches[node.end] === matches[node.start]) {
      id = node.next
      continue
    }
    visible.push(id)
    id = node.source < 0 && !matches && !expanded(node) ? node.next : id + 1
  }
  return visible
}

/** Folder/filter selection changes only that scope and preserves engine indices. */
export function toggleFileTreeRange(
  tree: FileTree,
  selected: ReadonlySet<number>,
  start: number,
  end: number,
  matches?: Uint32Array
): number[] {
  let all = true
  for (let i = start; i < end; i++) {
    if (matches && matches[i + 1] === matches[i]) continue
    if (!selected.has(tree.source[tree.leaves[i]].index)) {
      all = false
      break
    }
  }
  const next = new Set(selected)
  for (let i = start; i < end; i++) {
    if (matches && matches[i + 1] === matches[i]) continue
    const index = tree.source[tree.leaves[i]].index
    if (all) next.delete(index)
    else next.add(index)
  }
  return [...next]
}
