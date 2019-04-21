import router from '@/router'
import store from '@/store'
import CommandManager from './CommandManager'
import { Message } from 'element-ui'
import { getLocaleManager } from '@/components/Locale'
import { base64StringToBlob } from 'blob-util'
import { buildFileList } from '@shared/utils'

const commands = new CommandManager()
const i18n = getLocaleManager().getI18n()

function updateSystemTheme (theme) {
  store.dispatch('app/updateSystemTheme', theme)
}

function showAboutPanel () {
  store.dispatch('app/showAboutPanel')
}

function showAddTask (taskType = 'uri') {
  store.dispatch('app/showAddTaskDialog', taskType)
}

function showAddBtTaskWithFile (fileName, base64Data = '') {
  const blob = base64StringToBlob(base64Data, 'application/x-bittorrent')
  const file = new File([blob], fileName, { type: 'application/x-bittorrent' })
  const fileList = buildFileList(file)
  store.dispatch('app/showAddTaskDialog', 'torrent')
  setTimeout(() => {
    store.dispatch('app/addTaskAddTorrents', { fileList })
  }, 200)
}

function navigateTaskList (status = 'active') {
  router.push({ path: `/task/${status}` })
}

function navigatePreferences () {
  router.push({ path: '/preference' })
}

function showUnderDevelopmentMessage () {
  Message.info(i18n.t('app.under-development-message'))
}

function pauseTask () {
  showUnderDevelopmentMessage()
}

function resumeTask () {
  showUnderDevelopmentMessage()
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

commands.register('application:theme', updateSystemTheme)
commands.register('application:about', showAboutPanel)
commands.register('application:new-task', showAddTask)
commands.register('application:new-bt-task', showAddTask)
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

export {
  commands
}
