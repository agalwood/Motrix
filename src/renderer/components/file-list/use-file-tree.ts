import {
  buildFileTree,
  createFileTree,
  hasFileTreeStructure,
} from '@shared/lib/file-tree'
import type { BaseFileRow } from '@shared/types/file-row'
import { useEffect, useMemo, useState } from 'react'

const SYNC_LIMIT = 2_000

export function useFileTree<T extends BaseFileRow>(
  files: T[],
  hierarchical: boolean
) {
  const [tree, setTree] = useState(() =>
    buildFileTree(files.length <= SYNC_LIMIT ? files : [], hierarchical)
  )
  const ready = useMemo(
    () => hasFileTreeStructure(tree, files, hierarchical),
    [tree, files, hierarchical]
  )

  useEffect(() => {
    if (ready) return
    const builder = createFileTree(files, hierarchical)
    let timer: ReturnType<typeof setTimeout>
    function step() {
      const deadline = performance.now() + 8
      let result = builder.next()
      while (!result.done && performance.now() < deadline)
        result = builder.next()
      if (result.done) setTree(result.value)
      else timer = setTimeout(step, 0)
    }
    step()
    return () => clearTimeout(timer)
  }, [files, hierarchical, ready])

  // Keep the scroll surface mounted during renames; stale rows cannot be edited.
  return { tree, ready, displayFiles: ready ? files : (tree.source as T[]) }
}
