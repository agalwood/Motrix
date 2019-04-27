import api from '@/api'

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
  save ({ commit }, data) {
    let { btTracker } = data
    btTracker = btTracker.trim().replace(/(?:\r\n|\r|\n)/g, ',')
    const config = {
      ...data,
      btTracker
    }
    commit('UPDATE_PREFERENCE_DATA', config)
    return api.savePreference(config)
  },
  changeThemeConfig ({ commit }, theme) {
    commit('UPDATE_PREFERENCE_DATA', { theme })
  },
  fetchBtTracker () {
    return api.fetchBtTrackerFromGitHub()
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
