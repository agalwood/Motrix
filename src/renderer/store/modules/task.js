import api from '@/api'

const state = {
  currentList: 'active',
  taskItemInfoVisible: false,
  currentTaskItem: null,
  taskList: []
}

const listTitles = {
  'active': '下载中',
  'waiting': '已暂停',
  'stopped': '已完成'
}

const getters = {
  currentListTitle: (state, getters) => {
    return listTitles[state.currentList] ? listTitles[state.currentList] : ''
  }
}

const mutations = {
  UPDATE_TASK_LIST (state, taskList) {
    state.taskList = taskList
  },
  CHANGE_CURRENT_LIST (state, currentList) {
    state.currentList = currentList
  },
  CHANGE_TASK_ITEM_INFO_VISIBLE (state, visible) {
    state.taskItemInfoVisible = visible
  },
  UPDATE_CURRENT_TASK_ITEM (state, task) {
    state.currentTaskItem = task
  }
}

const actions = {
  changeCurrentList ({ commit, dispatch }, currentList) {
    commit('CHANGE_CURRENT_LIST', currentList)
    dispatch('fetchList')
  },
  fetchList ({ state, commit }) {
    console.log('fetchList===>')
    api.fetchTaskList({ type: state.currentList })
      .then((data) => {
        console.log('data===>', data)
        commit('UPDATE_TASK_LIST', data)
      })
  },
  fetchItem ({ dispatch }, gid) {
    api.fetchTaskItem({ gid })
      .then((data) => {
        console.log('data===>', data)
        dispatch('updateCurrentTaskItem', data)
      })
  },
  showTaskItemInfoDialog ({ commit, dispatch }, task) {
    dispatch('updateCurrentTaskItem', task)
    commit('CHANGE_TASK_ITEM_INFO_VISIBLE', true)
  },
  hideTaskItemInfoDialog ({ commit }) {
    commit('CHANGE_TASK_ITEM_INFO_VISIBLE', false)
  },
  updateCurrentTaskItem ({ commit }, task) {
    commit('UPDATE_CURRENT_TASK_ITEM', task)
  },
  addUri ({ dispatch }, data) {
    const { uris, options } = data
    return api.addUri({ uris, options })
      .then(() => {
        dispatch('fetchList')
      })
  },
  addTorrent ({ dispatch }, data) {
    const { torrent, options } = data
    return api.addTorrent({ torrent, options })
      .then(() => {
        dispatch('fetchList')
      })
  },
  addMetalink ({ dispatch }, data) {
    const { metalink, options } = data
    return api.addMetalink({ metalink, options })
      .then(() => {
        dispatch('fetchList')
      })
  },
  removeTask ({ dispatch }, task) {
    const { gid } = task
    console.log('removeTask', gid)
    return api.removeTask({ gid })
      .catch(() => {
        return api.forceRemoveTask({ gid })
      })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  pauseTask ({ dispatch }, task) {
    const { gid } = task
    console.log('pauseTask', gid)
    return api.pauseTask({ gid })
      .catch(() => {
        return api.forcePauseTask({ gid })
      })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  resumeTask ({ dispatch }, task) {
    const { gid } = task
    console.log('resumeTask', gid)
    return api.resumeTask({ gid })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  pauseAllTask ({ dispatch }) {
    console.log('pauseAllTask===>')
    return api.pauseAllTask()
      .catch(() => {
        return api.forcePauseAllTask()
      })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  resumeAllTask ({ dispatch }) {
    console.log('resumeAllTask===>')
    return api.resumeAllTask()
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  removeTaskRecord ({ dispatch }, task) {
    const { gid } = task
    console.log('removeTaskRecord', gid)
    return api.removeTaskRecord({ gid })
      .finally(() => dispatch('fetchList'))
  },
  saveSession () {
    api.saveSession()
  },
  purgeTaskRecord ({ dispatch }) {
    return api.purgeTaskRecord()
      .finally(() => dispatch('fetchList'))
  },
  toggleTask ({ dispatch }, task) {
    console.log('切换任务状态===>', task)
    const { status } = task
    if (status === 'active') {
      return dispatch('pauseTask', task)
    } else if (status === 'waiting' || status === 'paused') {
      return dispatch('resumeTask', task)
    }
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
