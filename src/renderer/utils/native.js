import is from 'electron-is'
import { access, constants } from 'fs'
import { Message } from 'element-ui'

import {
  isMagnetTask,
  getTaskFullPath,
  bytesToSize
} from '@shared/utils'
import { APP_THEME, TASK_STATUS } from '@shared/constants'

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

  access(fullPath, constants.F_OK, (err) => {
    console.log(`${fullPath} ${err ? 'does not exist' : 'exists'}`)
    if (err) {
      Message.error(errorMsg)
      return
    }

    remote.shell.showItemInFolder(fullPath)
  })
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

export function moveTaskFilesToTrash (task) {
  /**
   * For magnet link tasks, there is bittorrent, but there is no bittorrent.info.
   * The path is not a complete path before it becomes a BT task.
   * In order to avoid accidentally deleting the directory
   * where the task is located, it directly returns true when deleting.
   */
  if (isMagnetTask(task)) {
    return true
  }

  const { dir, status } = task
  const path = getTaskFullPath(task)
  if (!path || dir === path) {
    throw new Error('task.file-path-error')
  }

  let deleteResult1 = true
  access(path, constants.F_OK, (err) => {
    console.log(`${path} ${err ? 'does not exist' : 'exists'}`)
    if (!err) {
      deleteResult1 = remote.shell.moveItemToTrash(path)
    }
  })

  // There is no configuration file for the completed task.
  if (status === TASK_STATUS.COMPLETE) {
    return deleteResult1
  }

  let deleteResult2 = true
  const extraFilePath = `${path}.aria2`
  access(extraFilePath, constants.F_OK, (err) => {
    console.log(`${extraFilePath} ${err ? 'does not exist' : 'exists'}`)
    if (!err) {
      deleteResult2 = remote.shell.moveItemToTrash(extraFilePath)
    }
  })

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
  const text = downloadSpeed > 0 ? `${bytesToSize(downloadSpeed)}/s` : ''
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

export function getSystemTheme () {
  let result = APP_THEME.LIGHT
  if (!is.macOS()) {
    return result
  }
  result = remote.nativeTheme.shouldUseDarkColors ? APP_THEME.DARK : APP_THEME.LIGHT
  return result
}

export const openExternal = (url, options) => {
  if (!url) {
    return
  }

  remote.shell.openExternal(url, options)
}

export const delayDeleteTaskFiles = (task, delay) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        const result = moveTaskFilesToTrash(task)
        resolve(result)
      } catch (err) {
        console.log('[Motrix] batch delay delete task files fail', err)
        resolve(false)
      }
    }, delay)
  })
}
