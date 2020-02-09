import { ipcRenderer, remote } from 'electron'
import is from 'electron-is'
import { isEmpty } from 'lodash'
import Aria2 from 'aria2'
import {
  separateConfig,
  compactUndefined,
  formatOptionsForEngine,
  mergeTaskResult,
  changeKeysToCamelCase,
  changeKeysToKebabCase
} from '@shared/utils'
import { EMPTY_STRING } from '@shared/constants'

const application = remote.getGlobal('application')

export default class Api {
  constructor (options = {}) {
    this.options = options

    this.client = null
    this.init()
  }

  init () {
    this.loadConfig()
    this.initClient()
  }

  loadConfigFromLocalStorage () {
    // TODO
    const result = {}
    return result
  }

  loadConfigFromNativeStore () {
    const systemConfig = application.configManager.getSystemConfig()
    const userConfig = application.configManager.getUserConfig()

    const result = { ...systemConfig, ...userConfig }
    return result
  }

  loadConfig () {
    let result = is.renderer()
      ? this.loadConfigFromNativeStore()
      : this.loadConfigFromLocalStorage()

    result = changeKeysToCamelCase(result)
    this.config = result
  }

  initClient () {
    const {
      rpcListenPort: port,
      rpcSecret: secret
    } = this.config
    const host = '127.0.0.1'
    this.client = new Aria2({
      host,
      port,
      secret
    })
    this.client.open()
  }

  closeClient () {
    this.client.close()
      .then(() => {
        this.client = null
      })
      .catch(err => {
        console.log('engine client close fail', err)
      })
  }

  fetchPreference () {
    return new Promise((resolve) => {
      this.loadConfig()
      resolve(this.config)
    })
  }

  savePreference (params = {}) {
    const kebabParams = changeKeysToKebabCase(params)
    if (is.renderer()) {
      return this.savePreferenceToNativeStore(kebabParams)
    } else {
      return this.savePreferenceToLocalStorage(kebabParams)
    }
  }

  savePreferenceToLocalStorage () {
    // TODO
  }

  savePreferenceToNativeStore (params = {}) {
    const { user, system, others } = separateConfig(params)
    if (!isEmpty(system)) {
      console.info('[Motrix] save system config: ', system)
      ipcRenderer.send('command', 'application:save-preference', {
        system
      })
      this.changeGlobalOption(system)
    }

    if (!isEmpty(user)) {
      console.info('[Motrix] save user config: ', user)
      ipcRenderer.send('command', 'application:save-preference', {
        user
      })
    }

    if (!isEmpty(others)) {
      console.info('[Motrix] save config found illegal key: ', others)
    }
  }

  getVersion () {
    return this.client.call('getVersion')
  }

  changeGlobalOption (options) {
    const args = formatOptionsForEngine(options)

    return this.client.call('changeGlobalOption', args)
  }

  getGlobalOption () {
    return new Promise((resolve) => {
      this.client.call('getGlobalOption')
        .then((data) => {
          resolve(changeKeysToCamelCase(data))
        })
    })
  }

  getOption (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])

    return new Promise((resolve) => {
      this.client.call('getOption', ...args)
        .then((data) => {
          resolve(changeKeysToCamelCase(data))
        })
    })
  }

  changeOption (params = {}) {
    let { gid, options = {} } = params
    options = formatOptionsForEngine(options)

    const kebabOptions = changeKeysToKebabCase(options)
    const args = compactUndefined([gid, kebabOptions])

    return this.client.call('changeOption', ...args)
  }

  getGlobalStat () {
    return this.client.call('getGlobalStat')
  }

  addUri (params) {
    const {
      uris,
      outs,
      options
    } = params
    const tasks = uris.map((uri, index) => {
      const kebabOptions = changeKeysToKebabCase(options)
      if (outs && outs[index]) {
        kebabOptions['out'] = outs[index]
      }
      const args = compactUndefined([[uri], kebabOptions])
      return [ 'aria2.addUri', ...args ]
    })
    return this.client.multicall(tasks)
  }

  addTorrent (params) {
    const {
      torrent,
      options
    } = params
    const kebabOptions = changeKeysToKebabCase(options)
    const args = compactUndefined([torrent, [], kebabOptions])
    return this.client.call('addTorrent', ...args)
  }

  addMetalink (params) {
    const {
      metalink,
      options
    } = params
    const kebabOptions = changeKeysToKebabCase(options)
    const args = compactUndefined([metalink, kebabOptions])
    return this.client.call('addMetalink', ...args)
  }

  fetchDownloadingTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const activeArgs = compactUndefined([keys])
    const waitingArgs = compactUndefined([offset, num, keys])
    return new Promise((resolve, reject) => {
      this.client.multicall([
        [ 'aria2.tellActive', ...activeArgs ],
        [ 'aria2.tellWaiting', ...waitingArgs ]
      ]).then((data) => {
        console.log('fetchDownloadingTaskList data', data)
        const result = mergeTaskResult(data)
        resolve(result)
      }).catch((err) => {
        console.log('fetchDownloadingTaskList fail===>', err)
        reject(err)
      })
    })
  }

  fetchWaitingTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const args = compactUndefined([offset, num, keys])
    return this.client.call('tellWaiting', ...args)
  }

  fetchStoppedTaskList (params = {}) {
    const { offset = 0, num = 20, keys } = params
    const args = compactUndefined([offset, num, keys])
    return this.client.call('tellStopped', ...args)
  }

  fetchTaskList (params = {}) {
    const { type } = params
    switch (type) {
      case 'active':
        return this.fetchDownloadingTaskList(params)
      case 'waiting':
        return this.fetchWaitingTaskList(params)
      case 'stopped':
        return this.fetchStoppedTaskList(params)
      default:
        return this.fetchDownloadingTaskList(params)
    }
  }

  fetchTaskItem (params = {}) {
    const { gid, keys } = params
    const args = compactUndefined([gid, keys])
    return this.client.call('tellStatus', ...args)
  }

  pauseTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('pause', ...args)
  }

  pauseAllTask (params = {}) {
    return this.client.call('pauseAll')
  }

  forcePauseTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('forcePause', ...args)
  }

  forcePauseAllTask (params = {}) {
    return this.client.call('forcePauseAll')
  }

  resumeTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('unpause', ...args)
  }

  resumeAllTask (params = {}) {
    return this.client.call('unpauseAll')
  }

  removeTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('remove', ...args)
  }

  forceRemoveTask (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('forceRemove', ...args)
  }

  saveSession (params = {}) {
    return this.client.call('saveSession')
  }

  purgeTaskRecord (params = {}) {
    return this.client.call('purgeDownloadResult')
  }

  removeTaskRecord (params = {}) {
    const { gid } = params
    const args = compactUndefined([gid])
    return this.client.call('removeDownloadResult', ...args)
  }

  async fetchBtTrackerFromGitHub (source) {
    if (isEmpty(source)) {
      return EMPTY_STRING
    }

    const now = Date.now()
    const promises = source.map((url) => {
      return fetch(`${url}?t=${now}`).then((res) => res.text())
    })

    const resp = await Promise.all(promises)
    const values = [...new Set(resp)]
    let result = values.join('\r\n').replace(/^\s*[\r\n]/gm, '')
    return result
  }
}
