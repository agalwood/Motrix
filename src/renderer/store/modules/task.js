import api from '@/api'
import { TASK_STATUS } from '@shared/constants'
import { intersection } from '@shared/utils'

const state = {
  currentList: 'active',
  taskItemInfoVisible: false,
  currentTaskItem: null,
  seedingList: [],
  taskList: [],
  selectedGidList: []
}

const getters = {
}

const mutations = {
  UPDATE_SEEDING_LIST (state, seedingList) {
    state.seedingList = seedingList
  },
  UPDATE_TASK_LIST (state, taskList) {
    state.taskList = taskList
  },
  UPDATE_SELECTED_GID_LIST (state, gidList) {
    state.selectedGidList = gidList
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
    commit('UPDATE_SELECTED_GID_LIST', [])
    dispatch('fetchList')
  },
  fetchList ({ commit, state }) {
    return api.fetchTaskList({ type: state.currentList })
      .then((data) => {
        commit('UPDATE_TASK_LIST', data)

        const { selectedGidList } = state
        const gids = data.map((task) => task.gid)
        const list = intersection(selectedGidList, gids)
        commit('UPDATE_SELECTED_GID_LIST', list)
      })
  },
  selectTasks ({ commit }, list) {
    commit('UPDATE_SELECTED_GID_LIST', list)
  },
  selectAllTask ({ commit, state }) {
    const gids = state.taskList.map((task) => task.gid)
    commit('UPDATE_SELECTED_GID_LIST', gids)
  },
  fetchItem ({ dispatch }, gid) {
    return api.fetchTaskItem({ gid })
      .then((data) => {
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
    const { uris, outs, options } = data
    return api.addUri({ uris, outs, options })
      .then(() => {
        dispatch('fetchList')
        dispatch('app/updateAddTaskOptions', {}, { root: true })
      })
  },
  addTorrent ({ dispatch }, data) {
    const { torrent, options } = data
    return api.addTorrent({ torrent, options })
      .then(() => {
        dispatch('fetchList')
        dispatch('app/updateAddTaskOptions', {}, { root: true })
      })
  },
  addMetalink ({ dispatch }, data) {
    const { metalink, options } = data
    return api.addMetalink({ metalink, options })
      .then(() => {
        dispatch('fetchList')
        dispatch('app/updateAddTaskOptions', {}, { root: true })
      })
  },
  getTaskOption (_, gid) {
    return new Promise((resolve) => {
      api.getOption({ gid })
        .then((data) => {
          resolve(data)
        })
    })
  },
  changeTaskOption (_, payload) {
    const { gid, options } = payload
    return api.changeOption({ gid, options })
  },
  removeTask ({ dispatch }, task) {
    const { gid } = task
    return api.removeTask({ gid })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  forcePauseTask (_, task) {
    const { gid, status } = task
    if (status !== TASK_STATUS.ACTIVE) {
      return Promise.resolve(true)
    }

    return api.forcePauseTask({ gid })
  },
  pauseTask ({ dispatch }, task) {
    const { gid } = task
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
    return api.resumeTask({ gid })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  pauseAllTask ({ dispatch }) {
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
    return api.resumeAllTask()
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  addToSeedingList ({ state, commit }, gid) {
    const { seedingList } = state
    if (seedingList.includes(gid)) {
      return
    }

    const list = [
      ...seedingList,
      gid
    ]
    commit('UPDATE_SEEDING_LIST', list)
  },
  removeFromSeedingList ({ state, commit }, gid) {
    const { seedingList } = state
    const idx = seedingList.indexOf(gid)
    if (idx === -1) {
      return
    }

    const list = [...seedingList.slice(0, idx), ...seedingList.slice(idx + 1)]
    commit('UPDATE_SEEDING_LIST', list)
  },
  stopSeeding ({ dispatch }, { gid }) {
    const options = {
      seedTime: 0
    }
    return dispatch('changeTaskOption', { gid, options })
  },
  removeTaskRecord ({ dispatch }, task) {
    const { gid, status } = task
    const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
    if ([ERROR, COMPLETE, REMOVED].indexOf(status) === -1) {
      return
    }
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
    const { status } = task
    const { ACTIVE, WAITING, PAUSED } = TASK_STATUS
    if (status === ACTIVE) {
      return dispatch('pauseTask', task)
    } else if (status === WAITING || status === PAUSED) {
      return dispatch('resumeTask', task)
    }
  },
  batchResumeSelectedTasks ({ state }) {
    const gids = state.selectedGidList
    if (gids.length === 0) {
      return
    }

    return api.batchResumeTask({ gids })
  },
  batchPauseSelectedTasks ({ state }) {
    const gids = state.selectedGidList
    if (gids.length === 0) {
      return
    }

    return api.batchPauseTask({ gids })
  },
  batchForcePauseTask (_, gids) {
    return api.batchForcePauseTask({ gids })
  },
  batchResumeTask (_, gids) {
    return api.batchResumeTask({ gids })
  },
  batchRemoveTask ({ dispatch }, gids) {
    return api.batchRemoveTask({ gids })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
