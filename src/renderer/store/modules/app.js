import { ADD_TASK_TYPE } from '@shared/constants'
import api from '@/api'
import { getSystemTheme } from '@/utils/native'

const BASE_INTERVAL = 1000
const PER_INTERVAL = 100
const MIN_INTERVAL = 500
const MAX_INTERVAL = 6000

const state = {
  systemTheme: getSystemTheme(),
  trayFocused: false,
  aboutPanelVisible: false,
  engineInfo: {
    version: '',
    enabledFeatures: []
  },
  engineOptions: {},
  interval: BASE_INTERVAL,
  stat: {
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numWaiting: 0,
    numStopped: 0
  },
  addTaskVisible: false,
  addTaskType: ADD_TASK_TYPE.URI,
  addTaskUrl: '',
  addTaskTorrents: [],
  addTaskOptions: {},
  progress: 0
}

const getters = {
}

const mutations = {
  UPDATE_SYSTEM_THEME (state, theme) {
    state.systemTheme = theme
  },
  UPDATE_TRAY_FOCUSED (state, focused) {
    state.trayFocused = focused
  },
  UPDATE_ABOUT_PANEL_VISIBLE (state, visible) {
    state.aboutPanelVisible = visible
  },
  UPDATE_ENGINE_INFO (state, engineInfo) {
    state.engineInfo = { ...state.engineInfo, ...engineInfo }
  },
  UPDATE_ENGINE_OPTIONS (state, engineOptions) {
    state.engineOptions = { ...state.engineOptions, ...engineOptions }
  },
  UPDATE_GLOBAL_STAT (state, stat) {
    state.stat = stat
  },
  UPDATE_ADD_TASK_VISIBLE (state, visible) {
    state.addTaskVisible = visible
  },
  UPDATE_ADD_TASK_TYPE (state, taskType) {
    state.addTaskType = taskType
  },
  UPDATE_ADD_TASK_URL (state, text) {
    state.addTaskUrl = text
  },
  UPDATE_ADD_TASK_TORRENTS (state, fileList) {
    state.addTaskTorrents = [...fileList]
  },
  UPDATE_ADD_TASK_OPTIONS (state, options) {
    state.addTaskOptions = {
      ...options
    }
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
  },
  INCREASE_INTERVAL (state, millisecond) {
    if (state.interval < MAX_INTERVAL) {
      state.interval += millisecond
    }
  },
  DECREASE_INTERVAL (state, millisecond) {
    if (state.interval > MIN_INTERVAL) {
      state.interval -= millisecond
    }
  },
  UPDATE_PROGRESS (state, progress) {
    state.progress = progress
  }
}

const actions = {
  updateSystemTheme ({ commit }, theme) {
    commit('UPDATE_SYSTEM_THEME', theme)
  },
  updateTrayFocused ({ commit }, focused) {
    commit('UPDATE_TRAY_FOCUSED', focused)
  },
  showAboutPanel ({ commit }) {
    commit('UPDATE_ABOUT_PANEL_VISIBLE', true)
  },
  hideAboutPanel ({ commit }) {
    commit('UPDATE_ABOUT_PANEL_VISIBLE', false)
  },
  fetchEngineInfo ({ commit }) {
    api.getVersion()
      .then((data) => {
        commit('UPDATE_ENGINE_INFO', data)
      })
  },
  fetchEngineOptions ({ commit }) {
    return new Promise((resolve) => {
      api.getGlobalOption()
        .then((data) => {
          commit('UPDATE_ENGINE_OPTIONS', data)
          resolve(data)
        })
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
      })
  },
  increaseInterval ({ commit }, millisecond = 100) {
    commit('INCREASE_INTERVAL', millisecond)
  },
  showAddTaskDialog ({ commit }, taskType) {
    commit('UPDATE_ADD_TASK_TYPE', taskType)
    commit('UPDATE_ADD_TASK_VISIBLE', true)
  },
  hideAddTaskDialog ({ commit }) {
    commit('UPDATE_ADD_TASK_VISIBLE', false)
    commit('UPDATE_ADD_TASK_URL', '')
    commit('UPDATE_ADD_TASK_TORRENTS', [])
  },
  changeAddTaskType ({ commit }, taskType) {
    commit('UPDATE_ADD_TASK_TYPE', taskType)
  },
  updateAddTaskUrl ({ commit }, uri = '') {
    commit('UPDATE_ADD_TASK_URL', uri)
  },
  addTaskAddTorrents ({ commit }, { fileList }) {
    commit('UPDATE_ADD_TASK_TORRENTS', fileList)
  },
  updateAddTaskOptions ({ commit }, options = {}) {
    commit('UPDATE_ADD_TASK_OPTIONS', options)
  },
  updateInterval ({ commit }, millisecond) {
    commit('UPDATE_INTERVAL', millisecond)
  },
  resetInterval ({ commit }) {
    commit('UPDATE_INTERVAL', BASE_INTERVAL)
  },
  fetchProgress ({ commit }) {
    api.fetchActiveTaskList()
      .then((data) => {
        let progress = -1
        if (data.length !== 0) {
          data.forEach((task) => {
            task.totalLength = Number(task.totalLength)
            task.completedLength = Number(task.completedLength)
          })
          const realTotal = data.reduce((total, task) => total + task.totalLength, 0)
          if (realTotal === 0) {
            progress = 2
          } else {
            const tasks = data.filter((task) => task.totalLength !== 0)
            const completed = tasks.reduce((total, task) => total + task.completedLength, 0)
            const total = tasks.reduce((total, task) => total + task.totalLength, 0)
            progress = completed / total
          }
        }
        commit('UPDATE_PROGRESS', progress)
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
