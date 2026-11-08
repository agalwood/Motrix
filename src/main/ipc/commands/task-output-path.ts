import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'

function isWindowsDeviceNamespace(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return ['//?/', '//./', '/??/', '//??/'].some((prefix) =>
    normalized.startsWith(prefix)
  )
}

/** Validate task-owned paths before passing them to the desktop shell. */
export function normalizeTaskOutputPath(
  value: string,
  platform: NodeJS.Platform
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0') ||
    !pathApi.isAbsolute(value) ||
    isWindowsDeviceNamespace(value)
  ) {
    throw new AppError(ErrorCode.IpcInvalidPayload, 'Task has an invalid path')
  }

  // aria2 can return //server/share//file when dir has a trailing separator.
  // Electron converts separator direction but keeps the repeated separators.
  const output = platform === 'win32' ? path.win32.normalize(value) : value
  if (isWindowsDeviceNamespace(output)) {
    throw new AppError(ErrorCode.IpcInvalidPayload, 'Task has an invalid path')
  }
  return output
}
