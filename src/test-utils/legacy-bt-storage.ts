import {
  type BtStorageLayoutV1,
  btWorkspacePath,
  buildStagingOutputFilePaths,
  type ParsedBtFileLayout,
} from '@core/task/bt-storage-layout'

/** Construct persisted pre-retirement layouts for compatibility regressions. */
export function createBtStoragePlan(
  taskId: string,
  saveDir: string,
  parsed: ParsedBtFileLayout
) {
  const layout: BtStorageLayoutV1 = {
    version: 1,
    strategy: 'indexed-staging',
    workspacePath: btWorkspacePath(taskId, saveDir),
    payloadEntry: 'p',
    torrentRootName: parsed.torrentRootName,
    multiFile: parsed.multiFile,
  }
  return {
    layout,
    outputFilePaths: buildStagingOutputFilePaths(parsed, layout),
  }
}
