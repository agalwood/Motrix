import is from 'electron-is'
import { shell, nativeTheme } from '@electron/remote'
import { access, constants } from 'fs'
import { resolve } from 'path'
import { Message } from 'element-ui'

import {
  getFileNameFromFile,
  isMagnetTask,
  getSystemMajorVersion
} from '@shared/utils'
import { APP_THEME, TASK_STATUS } from '@shared/constants'

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

    shell.showItemInFolder(fullPath)
  })
}

export const openItem = async (fullPath) => {
  if (!fullPath) {
    return
  }

  const result = await shell.openPath(fullPath)
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
      fileName = getFileNameFromFile(file)
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
      // Electron >= 12.x
      // deleteResult1 = shell.trashItem(path)
      deleteResult1 = shell.moveItemToTrash(path)
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
      // Electron >= 12.x
      // deleteResult2 = shell.trashItem(extraFilePath)
      deleteResult2 = shell.moveItemToTrash(extraFilePath)
    }
  })

  return deleteResult1 && deleteResult2
}

export function getSystemTheme () {
  let result = APP_THEME.LIGHT
  if (!is.macOS()) {
    return result
  }
  result = nativeTheme.shouldUseDarkColors ? APP_THEME.DARK : APP_THEME.LIGHT
  return result
}

export function isBigSur () {
  return is.macOS() && getSystemMajorVersion() >= 20
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
