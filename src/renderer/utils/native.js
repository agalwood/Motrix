import { shell, nativeTheme } from '@electron/remote'
import { access, constants } from 'node:fs'
import { resolve } from 'node:path'
import { Message } from 'element-ui'

import {
  getFileNameFromFile,
  isMagnetTask
} from '@shared/utils'
import { APP_THEME, TASK_STATUS } from '@shared/constants'

export function showItemInFolder (fullPath, { errorMsg }) {
  if (!fullPath) {
    return
  }

  access(fullPath, constants.F_OK, (err) => {
    console.log(`[Motrix] ${fullPath} ${err ? 'does not exist' : 'exists'}`)
    if (err && errorMsg) {
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

export const moveTaskFilesToTrash = (task) => {
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
  access(path, constants.F_OK, async (err) => {
    console.log(`[Motrix] ${path} ${err ? 'does not exist' : 'exists'}`)
    if (!err) {
      deleteResult1 = await shell.trashItem(path)
    }
  })

  // There is no configuration file for the completed task.
  if (status === TASK_STATUS.COMPLETE) {
    return deleteResult1
  }

  let deleteResult2 = true
  const extraFilePath = `${path}.aria2`
  access(extraFilePath, constants.F_OK, async (err) => {
    console.log(`[Motrix] ${extraFilePath} ${err ? 'does not exist' : 'exists'}`)
    if (!err) {
      deleteResult2 = await shell.trashItem(extraFilePath)
    }
  })

  return deleteResult1 && deleteResult2
}

export function getSystemTheme () {
  return nativeTheme.shouldUseDarkColors ? APP_THEME.DARK : APP_THEME.LIGHT
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
