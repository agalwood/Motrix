import { AppError, ErrorCode } from '@shared/errors'

export interface RevealInFolderDeps {
  shell: { showItemInFolder: (path: string) => void }
}

export interface RevealInFolderPayload {
  path: string
}

export function createRevealInFolderHandler(deps: RevealInFolderDeps) {
  return async ({ path }: RevealInFolderPayload): Promise<void> => {
    if (!path) {
      throw new AppError(
        ErrorCode.IpcInvalidPayload,
        'revealInFolder: invalid empty path'
      )
    }
    deps.shell.showItemInFolder(path)
  }
}
