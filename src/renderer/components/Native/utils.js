import is from 'electron-is'
import { existsSync } from 'fs'
import { Message } from 'element-ui'
import {
  getTaskFullPath,
  bytesToSize
} from '@shared/utils'

const remote = is.renderer() ? require('electron').remote : {}

export function getUserDownloadsPath () {
  return remote.app.getPath('downloads')
}

export function prettifyDir (dir) {
  const downloads = getUserDownloadsPath()
  const result = dir === downloads ? '下载' : dir
  return result
}

export function showItemInFolder (fullPath) {
  if (!fullPath) {
    return
  }
  const result = remote.shell.showItemInFolder(fullPath)
  if (!result) {
    Message.error('目标文件不存在或已删除')
  }
  return result
}

export function moveTaskFilesToTrash (task) {
  const path = getTaskFullPath(task)
  if (!path) {
    Message.error('文件路径异常，请手动删除')
    return false
  }

  const deleteResult1 = remote.shell.moveItemToTrash(path)
  if (!deleteResult1) {
    Message.error('删除任务文件失败，请手动删除')
  }

  let deleteResult2 = true
  const extraFilePath = `${path}.aria2`
  const isExtraExist = existsSync(extraFilePath)
  if (isExtraExist) {
    deleteResult2 = remote.shell.moveItemToTrash(extraFilePath)
    if (!deleteResult2) {
      Message.error('删除任务配置文件失败，请手动删除')
    }
  }

  return deleteResult1 && deleteResult2
}

export function openDownloadDock (path) {
  remote.app.dock.downloadFinished(path)
}

export function updateDockBadge (text) {
  remote.app.dock.setBadge(text)
}

export function showDownloadSpeedInDock (downloadSpeed) {
  if (is.windows()) {
    return
  }
  const text = downloadSpeed > 0 ? bytesToSize(downloadSpeed) : ''
  updateDockBadge(text)
}

export function addToRecentTask (task) {
  const path = getTaskFullPath(task)
  remote.app.addRecentDocument(path)
}

export function addToRecentTaskByPath (path) {
  remote.app.addRecentDocument(path)
}

export function clearRecentTasks () {
  remote.app.clearRecentDocuments()
}
