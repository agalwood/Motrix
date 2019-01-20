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

export function moveTaskFilesToTrash (task, { pathErrorMsg, delFailMsg, delConfigFailMsg }) {
  const path = getTaskFullPath(task)
  if (!path && pathErrorMsg) {
    Message.error(pathErrorMsg)
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
