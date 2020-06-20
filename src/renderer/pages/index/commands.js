import { Message } from 'element-ui'
import { base64StringToBlob } from 'blob-util'

import router from '@/router'
import store from '@/store'
import { buildFileList } from '@shared/utils'
import { ADD_TASK_TYPE } from '@shared/constants'
import { getLocaleManager } from '@/components/Locale'
import { commands } from '@/components/CommandManager/instance'
import {
  initTaskForm,
  buildUriPayload,
  buildTorrentPayload
} from '@/utils/task'

const i18n = getLocaleManager().getI18n()

const updateSystemTheme = (payload = {}) => {
  const { theme } = payload
  store.dispatch('app/updateSystemTheme', theme)
}

const updateTheme = (payload = {}) => {
  const { theme } = payload
  store.dispatch('preference/changeThemeConfig', theme)
}

const showAboutPanel = () => {
  store.dispatch('app/showAboutPanel')
}

const addTask = (payload = {}) => {
  const {
    type = ADD_TASK_TYPE.URI,
    uri,
    silent,
    ...rest
  } = payload

  const options = {
    ...rest
  }

  if (type === ADD_TASK_TYPE.URI && uri) {
    store.dispatch('app/updateAddTaskUrl', uri)
  }
  store.dispatch('app/updateAddTaskOptions', options)

  if (silent) {
    addTaskSilent(type)
    return
  }

  store.dispatch('app/showAddTaskDialog', type)
}

const addTaskSilent = (type) => {
  try {
    addTaskByType(type)
  } catch (err) {
    Message.error(i18n.t(err.message))
  }
}

const addTaskByType = (type) => {
  const form = initTaskForm(store.state)

  let payload = null
  if (type === ADD_TASK_TYPE.URI) {
    payload = buildUriPayload(form)
    store.dispatch('task/addUri', payload).catch(err => {
      Message.error(err.message)
    })
  } else if (type === ADD_TASK_TYPE.TORRENT) {
    payload = buildTorrentPayload(form)
    store.dispatch('task/addTorrent', payload).catch(err => {
      Message.error(err.message)
    })
  } else if (type === 'metalink') {
  // @TODO addMetalink
  } else {
    console.error('addTask fail', form)
  }
}

const showAddBtTask = () => {
  store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.TORRENT)
}

const showAddBtTaskWithFile = (payload = {}) => {
  const { name, dataURL = '' } = payload
  if (!dataURL) {
    return
  }

  const blob = base64StringToBlob(dataURL, 'application/x-bittorrent')
  const file = new File([blob], name, { type: 'application/x-bittorrent' })
  const fileList = buildFileList(file)

  store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.TORRENT)
  setTimeout(() => {
    store.dispatch('app/addTaskAddTorrents', { fileList })
  }, 200)
}

const navigateTaskList = (payload = {}) => {
  const { status = 'active' } = payload

  router.push({ path: `/task/${status}` }).catch(err => {
    console.log(err)
  })
}

const navigatePreferences = () => {
  router.push({ path: '/preference' }).catch(err => {
    console.log(err)
  })
}

const showUnderDevelopmentMessage = () => {
  Message.info(i18n.t('app.under-development-message'))
}

const pauseTask = () => {
  store.dispatch('task/batchPauseSelectedTasks')
}

const resumeTask = () => {
  store.dispatch('task/batchResumeSelectedTasks')
}

const deleteTask = () => {
  commands.emit('batch-delete-task', {
    deleteWithFiles: false
  })
}

const moveTaskUp = () => {
  showUnderDevelopmentMessage()
}

const moveTaskDown = () => {
  showUnderDevelopmentMessage()
}

const pauseAllTask = () => {
  store.dispatch('task/pauseAllTask')
}

const resumeAllTask = () => {
  store.dispatch('task/resumeAllTask')
}

const selectAllTask = () => {
  store.dispatch('task/selectAllTask')
}

const fetchPreference = () => {
  store.dispatch('preference/fetchPreference')
}

commands.register('application:task-list', navigateTaskList)
commands.register('application:preferences', navigatePreferences)
commands.register('application:about', showAboutPanel)

commands.register('application:new-task', addTask)
commands.register('application:new-bt-task', showAddBtTask)
commands.register('application:new-bt-task-with-file', showAddBtTaskWithFile)
commands.register('application:pause-task', pauseTask)
commands.register('application:resume-task', resumeTask)
commands.register('application:delete-task', deleteTask)
commands.register('application:move-task-up', moveTaskUp)
commands.register('application:move-task-down', moveTaskDown)
commands.register('application:pause-all-task', pauseAllTask)
commands.register('application:resume-all-task', resumeAllTask)
commands.register('application:select-all-task', selectAllTask)

commands.register('application:update-preference-config', fetchPreference)
commands.register('application:update-system-theme', updateSystemTheme)
commands.register('application:update-theme', updateTheme)
