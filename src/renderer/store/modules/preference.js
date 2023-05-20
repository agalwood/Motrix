import { isEmpty } from 'lodash'

import api from '@/api'
import {
  getLangDirection,
  pushItemToFixedLengthArray,
  removeArrayItem
} from '@shared/utils'
import { fetchBtTrackerFromSource } from '@shared/utils/tracker'
import { MAX_NUM_OF_DIRECTORIES } from '@shared/constants'

const state = {
  engineMode: 'MAX',
  config: {}
}

const getters = {
  theme: state => state.config.theme,
  locale: state => state.config.locale,
  direction: state => getLangDirection(state.config.locale)
}

const mutations = {
  UPDATE_PREFERENCE_DATA (state, config) {
    state.config = { ...state.config, ...config }
  }
}

const actions = {
  fetchPreference ({ dispatch }) {
    return new Promise((resolve) => {
      api.fetchPreference()
        .then((config) => {
          dispatch('updatePreference', config)
          resolve(config)
        })
    })
  },
  save ({ dispatch }, config) {
    dispatch('task/saveSession', null, { root: true })
    if (isEmpty(config)) {
      return
    }

    dispatch('updatePreference', config)
    return api.savePreference(config)
  },
  recordHistoryDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config
    const all = new Set([...historyDirectories, ...favoriteDirectories])
    if (all.has(directory)) {
      return
    }

    dispatch('addHistoryDirectory', directory)
  },
  addHistoryDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [] } = state.config
    const history = pushItemToFixedLengthArray(
      historyDirectories,
      MAX_NUM_OF_DIRECTORIES,
      directory
    )

    dispatch('save', { historyDirectories: history })
  },
  favoriteDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config
    if (favoriteDirectories.includes(directory) ||
      favoriteDirectories.length >= MAX_NUM_OF_DIRECTORIES
    ) {
      return
    }

    const favorite = pushItemToFixedLengthArray(
      favoriteDirectories,
      MAX_NUM_OF_DIRECTORIES,
      directory
    )
    const history = removeArrayItem(historyDirectories, directory)

    dispatch('save', {
      historyDirectories: history,
      favoriteDirectories: favorite
    })
  },
  cancelFavoriteDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config
    if (historyDirectories.includes(directory)) {
      return
    }

    const favorite = removeArrayItem(favoriteDirectories, directory)

    const history = pushItemToFixedLengthArray(
      historyDirectories,
      MAX_NUM_OF_DIRECTORIES,
      directory
    )

    dispatch('save', {
      historyDirectories: history,
      favoriteDirectories: favorite
    })
  },
  removeDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config

    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = removeArrayItem(historyDirectories, directory)

    dispatch('save', {
      historyDirectories: history,
      favoriteDirectories: favorite
    })
  },
  updateAppTheme ({ dispatch }, theme) {
    dispatch('updatePreference', { theme })
  },
  updatePreference  ({ commit }, config) {
    commit('UPDATE_PREFERENCE_DATA', config)
  },
  fetchBtTracker (_, trackerSource = []) {
    return fetchBtTrackerFromSource(trackerSource)
  },
  toggleEngineMode () {

  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
