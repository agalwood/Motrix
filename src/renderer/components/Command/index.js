import router from '@/router'
import store from '@/store'
import CommandManager from './CommandManager'

const commands = new CommandManager()

function showAboutPanel () {
  store.dispatch('app/showAboutPanel')
}

function showAddTask (taskType = 'uri') {
  store.dispatch('app/showAddTaskDialog', taskType)
}

function navigateTaskList (status = 'active') {
  router.push({ path: `/task/${status}` })
}

function navigatePreferences () {
  router.push({ path: '/preference' })
}

function pauseTask () {

}

function resumeTask () {

}

function deleteTask () {

}

function moveTaskUp () {

}

function moveTaskDown () {

}

function pauseAllTask () {
  store.dispatch('task/pauseAllTask')
}

function resumeAllTask () {
  store.dispatch('task/resumeAllTask')
}

commands.register('application:about', showAboutPanel)
commands.register('application:new-task', showAddTask)
commands.register('application:new-bt-task', showAddTask)
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
