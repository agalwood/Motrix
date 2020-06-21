import is from 'electron-is'
import { access, constants } from 'fs'
import { resolve } from 'path'
import { Message } from 'element-ui'

import {
  getFileName,
  isMagnetTask
} from '@shared/utils'
import { APP_THEME, TASK_STATUS } from '@shared/constants'

const remote = is.renderer() ? require('electron').remote : {}

export function showItemInFolder (fullPath, { errorMsg }) {
  if (!fullPath) {
    return
  }

  access(fullPath, constants.F_OK, (err) => {
    console.log(`[Motrix] ${fullPath} ${err ? 'does not exist' : 'exists'}`)
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

export function getTaskFullPath (task) {
  const { dir, files, bittorrent } = task
  let result = resolve(dir)

  // Magnet link task
  if (isMagnetTask(task)) {
    return result
  }

  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = resolve(result, bittorrent.info.name)
    return result
  }

  const [file] = files
  const path = file.path ? resolve(file.path) : ''
  let fileName = ''

  if (path) {
    result = path
  } else {
    if (files && files.length === 1) {
      fileName = getFileName(file)
      if (fileName) {
        result = resolve(result, fileName)
      }
    }
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
    console.log(`[Motrix] ${path} ${err ? 'does not exist' : 'exists'}`)
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
    console.log(`[Motrix] ${extraFilePath} ${err ? 'does not exist' : 'exists'}`)
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
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const result = moveTaskFilesToTrash(task)
        resolve(result)
      } catch (err) {
        reject(err.message)
      }
    }, delay)
  })
}
