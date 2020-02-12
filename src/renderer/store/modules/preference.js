import api from '@/api'
import { isEmpty } from 'lodash'

const state = {
  engineMode: 'MAX',
  config: {}
}

const mutations = {
  UPDATE_PREFERENCE_DATA (state, config) {
    state.config = { ...state.config, ...config }
  }
}

const actions = {
  fetchPreference ({ commit }) {
    return new Promise((resolve) => {
      api.fetchPreference()
        .then((config) => {
          commit('UPDATE_PREFERENCE_DATA', config)
          resolve(config)
        })
    })
  },
  save ({ commit, dispatch }, config) {
    dispatch('task/saveSession', null, { root: true })
    if (isEmpty(config)) {
      return
    }

    commit('UPDATE_PREFERENCE_DATA', config)
    return api.savePreference(config)
  },
  changeThemeConfig ({ commit }, theme) {
    commit('UPDATE_PREFERENCE_DATA', { theme })
  },
  fetchBtTracker (_, trackerSource = []) {
    return api.fetchBtTrackerFromGitHub(trackerSource)
  },
  toggleEngineMode () {

  }
}

export default {
  namespaced: true,
  state,
  mutations,
  actions
}
