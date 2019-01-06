import is from 'electron-is'
import api from '@/api'

const BASE_INTERVAL = 1000
const PER_INTERVAL = 100
const MIN_INTERVAL = 500
const MAX_INTERVAL = 6000

const state = {
  aboutPanelVisible: false,
  engineInfo: {
    version: '',
    enabledFeatures: []
  },
  interval: BASE_INTERVAL,
  stat: {
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numStopped: 0,
    numWaiting: 0
  },
  addTaskVisible: false,
  addTaskType: 'uri'
}

const getters = {
}

const mutations = {
  CHANGE_ABOUT_PANEL_VISIBLE (state, visible) {
    state.aboutPanelVisible = visible
  },
  UPDATE_ENGINE_INFO (state, engineInfo) {
    state.engineInfo = { ...state.engineInfo, ...engineInfo }
  },
  UPDATE_GLOBAL_STAT (state, stat) {
    state.stat = stat
  },
  CHANGE_ADD_TASK_VISIBLE (state, visible) {
    state.addTaskVisible = visible
  },
  CHANGE_ADD_TASK_TYPE (state, taskType) {
    state.addTaskType = taskType
  },
  UPDATE_INTERVAL (state, millisecond) {
    let interval = millisecond
    if (millisecond > MAX_INTERVAL) {
      interval = MAX_INTERVAL
    }
    if (millisecond < MIN_INTERVAL) {
      interval = MIN_INTERVAL
    }
    if (state.interval === interval) {
      return
    }
    state.interval = interval
    console.log('current interval===>', state.interval)
  },
  INCREASE_INTERVAL (state, millisecond) {
    if (state.interval < MAX_INTERVAL) {
      state.interval += millisecond
    }
    console.log('current interval===>', state.interval)
  },
  DECREASE_INTERVAL (state, millisecond) {
    if (state.interval > MIN_INTERVAL) {
      state.interval -= millisecond
    }
    console.log('current interval===>', state.interval)
  }
}

const actions = {
  showAboutPanel ({ commit }) {
    commit('CHANGE_ABOUT_PANEL_VISIBLE', true)
  },
  hideAboutPanel ({ commit }) {
    commit('CHANGE_ABOUT_PANEL_VISIBLE', false)
  },
  fetchEngineInfo ({ commit }) {
    api.getVersion()
      .then((data) => {
        commit('UPDATE_ENGINE_INFO', data)
      })
  },
  fetchGlobalStat ({ commit, dispatch }) {
    api.getGlobalStat()
      .then((data) => {
        const stat = {}
        Object.keys(data).forEach((key) => {
          stat[key] = Number(data[key])
        })

        const { numActive } = stat
        if (numActive > 0) {
          const interval = BASE_INTERVAL - PER_INTERVAL * numActive
          dispatch('updateInterval', interval)
        } else {
          // fix downloadSpeed when numActive = 0
          stat.downloadSpeed = 0
          dispatch('increaseInterval')
        }
        commit('UPDATE_GLOBAL_STAT', stat)

        if (is.renderer()) {
          dispatch('togglePowerSaveBlocker', numActive)
        }
      })
  },
  togglePowerSaveBlocker (context, numActive) {
    if (numActive > 0) {
      api.startPowerSaveBlocker()
    } else {
      api.stopPowerSaveBlocker()
    }
  },
  increaseInterval ({ commit }, millisecond = 100) {
    commit('INCREASE_INTERVAL', millisecond)
  },
  showAddTaskDialog ({ commit }, taskType) {
    commit('CHANGE_ADD_TASK_TYPE', taskType)
    commit('CHANGE_ADD_TASK_VISIBLE', true)
  },
  hideAddTaskDialog ({ commit }) {
    commit('CHANGE_ADD_TASK_VISIBLE', false)
  },
  changeAddTaskType ({ commit }, taskType) {
    commit('CHANGE_ADD_TASK_TYPE', taskType)
  },
  updateInterval ({ commit }, millisecond) {
    commit('UPDATE_INTERVAL', millisecond)
  },
  resetInterval ({ commit }) {
    commit('UPDATE_INTERVAL', BASE_INTERVAL)
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
