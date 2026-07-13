import { isEmpty } from 'lodash'
import axios from 'axios'
import { MAX_BT_TRACKER_LENGTH, ONE_SECOND, PROXY_SCOPES } from '@shared/constants'

export const convertToAxiosProxy = (proxyServer = '') => {
  if (!proxyServer) {
    return
  }

  const url = new URL(proxyServer)
  const { username, password, protocol = 'http:', hostname, port } = url

  let result = {
    protocol: protocol.replace(':', ''),
    host: hostname,
    port
  }

  const auth = username || password
    ? {
      username,
      password
    }
    : undefined

  if (auth) {
    result = {
      ...result,
      auth
    }
  }

  return result
}

export const fetchBtTrackerFromSource = async (source, proxyConfig = {}) => {
  if (isEmpty(source)) {
    return []
  }

  const now = Date.now()
  const { enable, server, scope = [] } = proxyConfig
  const proxy = enable && server && scope.includes(PROXY_SCOPES.UPDATE_TRACKERS)
    ? convertToAxiosProxy(server)
    : undefined

  const ALLOWED_PROTOCOLS = ['http:', 'https:']
  const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|::1)/i
  const isValidTrackerUrl = (u) => {
    try {
      const { protocol, hostname } = new URL(u)
      return ALLOWED_PROTOCOLS.includes(protocol) && !PRIVATE_HOST_RE.test(hostname)
    } catch {
      return false
    }
  }

  // Axios's config.proxy is Node.js only
  const promises = source.filter(isValidTrackerUrl).map(async (url) => {
    return axios.get(`${url}?t=${now}`, {
      timeout: 30 * ONE_SECOND,
      proxy
    }).then((value) => value.data)
  })

  const results = await Promise.allSettled(promises)
  const values = results.map((item) => item.value)
  const result = [...new Set(values)]
  return result
}

export const convertTrackerDataToLine = (arr = []) => {
  const result = arr.join('\r\n').replace(/^\s*[\r\n]/gm, '').trim()
  return result
}

export const convertTrackerDataToComma = (arr = []) => {
  const result = convertTrackerDataToLine(arr).replace(/(?:\r\n|\r|\n)/g, ',').trim()
  return result
}

export const reduceTrackerString = (str = '') => {
  if (str.length <= MAX_BT_TRACKER_LENGTH) {
    return str
  }

  const subStr = str.substring(0, MAX_BT_TRACKER_LENGTH)
  const index = subStr.lastIndexOf(',')
  if (index === -1) {
    return subStr
  }

  const result = subStr.substring(0, index)
  return result
}
