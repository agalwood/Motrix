import { Message } from 'element-ui'
import { base64StringToBlob } from 'blob-util'

import router from '@/router'
import store from '@/store'
import { buildFileList } from '@shared/utils'
import { ADD_TASK_TYPE } from '@shared/constants'
import { getLocaleManager } from '@/components/Locale'
import CommandManager from './CommandManager'

const commands = new CommandManager()
const i18n = getLocaleManager().getI18n()

function updateSystemTheme (theme) {
  store.dispatch('app/updateSystemTheme', theme)
}

function updateTheme (theme) {
  store.dispatch('preference/changeThemeConfig', theme)
}

function showAboutPanel () {
  store.dispatch('app/showAboutPanel')
}

function showAddTask (taskType = ADD_TASK_TYPE.URI, task = '') {
  if (taskType === ADD_TASK_TYPE.URI && task) {
    store.dispatch('app/updateAddTaskUrl', task)
  }
  store.dispatch('app/showAddTaskDialog', taskType)
}

function showAddBtTask () {
  store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.TORRENT)
}

function showAddBtTaskWithFile (fileName, base64Data = '') {
  const blob = base64StringToBlob(base64Data, 'application/x-bittorrent')
  const file = new File([blob], fileName, { type: 'application/x-bittorrent' })
  const fileList = buildFileList(file)
  store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.TORRENT)
  setTimeout(() => {
    store.dispatch('app/addTaskAddTorrents', { fileList })
  }, 200)
}

function navigateTaskList (status = 'active') {
  router.push({ path: `/task/${status}` }).catch(err => {
    console.log(err)
  })
}

function navigatePreferences () {
  router.push({ path: '/preference' }).catch(err => {
    console.log(err)
  })
}

function showUnderDevelopmentMessage () {
  Message.info(i18n.t('app.under-development-message'))
}

function pauseTask () {
  store.dispatch('task/batchPauseSelectedTasks')
}

function resumeTask () {
  store.dispatch('task/batchResumeSelectedTasks')
}

function deleteTask () {
  showUnderDevelopmentMessage()
}

function moveTaskUp () {
  showUnderDevelopmentMessage()
}

function moveTaskDown () {
  showUnderDevelopmentMessage()
}

function pauseAllTask () {
  store.dispatch('task/pauseAllTask')
}

function resumeAllTask () {
  store.dispatch('task/resumeAllTask')
}

function selectAllTask () {
  store.dispatch('task/selectAllTask')
}

commands.register('application:system-theme', updateSystemTheme)
commands.register('application:theme', updateTheme)
commands.register('application:about', showAboutPanel)
commands.register('application:new-task', showAddTask)
commands.register('application:new-bt-task', showAddBtTask)
commands.register('application:new-bt-task-with-file', showAddBtTaskWithFile)
commands.register('application:task-list', navigateTaskList)
commands.register('application:preferences', navigatePreferences)

commands.register('application:pause-task', pauseTask)
commands.register('application:resume-task', resumeTask)
commands.register('application:delete-task', deleteTask)
commands.register('application:move-task-up', moveTaskUp)
commands.register('application:move-task-down', moveTaskDown)
commands.register('application:pause-all-task', pauseAllTask)
commands.register('application:resume-all-task', resumeAllTask)
commands.register('application:select-all-task', selectAllTask)

export {
  commands
}
