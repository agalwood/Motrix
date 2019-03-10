import is from 'electron-is'
import { existsSync } from 'fs'
import { Message } from 'element-ui'
import {
  isMagnetTask,
  getTaskFullPath,
  bytesToSize
} from '@shared/utils'

const remote = is.renderer() ? require('electron').remote : {}

export function getUserDownloadsPath () {
  return remote.app.getPath('downloads')
}

export function prettifyDir (dir) {
  const downloads = getUserDownloadsPath()
  const result = dir === downloads ? 'Downloads' : dir
  return result
}

export function showItemInFolder (fullPath, { errorMsg }) {
  if (!fullPath) {
    return
  }
  const result = remote.shell.showItemInFolder(fullPath)
  if (!result && errorMsg) {
    Message.error(errorMsg)
  }
  return result
}

export function openItem (fullPath, { errorMsg }) {
  if (!fullPath) {
    return
  }
  const result = remote.shell.openItem(fullPath)
  if (!result && errorMsg) {
    Message.error(errorMsg)
  }
  return result
}

export function moveTaskFilesToTrash (task, messages = {}) {
  /**
   * 磁力链接任务，有 bittorrent，但没有 bittorrent.info ，
   * 在没下完变成BT任务之前 path 不是一个完整路径，
   * 未避免误删所在目录，所以删除时直接返回 true
   */
  if (isMagnetTask(task)) {
    return true
  }

  const { pathErrorMsg, delFailMsg, delConfigFailMsg } = messages
  const { dir } = task
  const path = getTaskFullPath(task)
  if (!path || dir === path) {
    if (pathErrorMsg) {
      Message.error(pathErrorMsg)
    }
    return false
  }

  const deleteResult1 = remote.shell.moveItemToTrash(path)
  if (!deleteResult1 && delFailMsg) {
    Message.error(delFailMsg)
  }

  let deleteResult2 = true
  const extraFilePath = `${path}.aria2`
  const isExtraExist = existsSync(extraFilePath)
  if (isExtraExist) {
    deleteResult2 = remote.shell.moveItemToTrash(extraFilePath)
    if (!deleteResult2 && delConfigFailMsg) {
      Message.error(delConfigFailMsg)
    }
  }

  return deleteResult1 && deleteResult2
}

export function openDownloadDock (path) {
  if (!is.macOS()) {
    return
  }
  remote.app.dock.downloadFinished(path)
}

export function updateDockBadge (text) {
  if (!is.macOS()) {
    return
  }
  remote.app.dock.setBadge(text)
}

export function showDownloadSpeedInDock (downloadSpeed) {
  if (!is.macOS()) {
    return
  }
  const text = downloadSpeed > 0 ? bytesToSize(downloadSpeed) : ''
  updateDockBadge(text)
}

export function addToRecentTask (task) {
  if (is.linux()) {
    return
  }
  const path = getTaskFullPath(task)
  remote.app.addRecentDocument(path)
}

export function addToRecentTaskByPath (path) {
  if (is.linux()) {
    return
  }
  remote.app.addRecentDocument(path)
}

export function clearRecentTasks () {
  if (is.linux()) {
    return
  }
  remote.app.clearRecentDocuments()
}
