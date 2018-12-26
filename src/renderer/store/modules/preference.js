import api from '@/api'

const state = {
  currentForm: 'basic',
  engineMode: 'MAX',
  config: {}
}

const formTitles = {
  'basic': '基础设置',
  'advanced': '进阶设置',
  'lab': '实验室'
}

const getters = {
  currentFormTitle: (state, getters) => {
    return formTitles[state.currentForm] ? formTitles[state.currentForm] : ''
  }
}

const mutations = {
  UPDATE_PREFERENCE_DATA (state, config) {
    state.config = { ...state.config, ...config }
  },
  CHANGE_CURRENT_FORM (state, currentForm) {
    state.currentForm = currentForm
  }
}

const actions = {
  changeCurrentForm ({ commit }, currentForm) {
    commit('CHANGE_CURRENT_FORM', currentForm)
  },
  fetchPreference ({ commit }) {
    return new Promise((resolve) => {
      api.fetchPreference()
        .then((config) => {
          commit('UPDATE_PREFERENCE_DATA', config)
          resolve(config)
        })
    })
  },
  save ({ commit }, config) {
    commit('UPDATE_PREFERENCE_DATA', config)
    return api.savePreference(config)
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
