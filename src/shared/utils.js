import {
  isEmpty,
  isNaN,
  compact,
  difference,
  parseInt,
  isFunction,
  camelCase,
  kebabCase
} from 'lodash'
import { userKeys, systemKeys } from './configKeys'

export function bytesToSize (bytes) {
  const b = parseInt(bytes, 10)
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  if (b === 0) { return '0 KB' }
  const i = parseInt(Math.floor(Math.log(b) / Math.log(1024)), 10)
  if (i === 0) { return `${b} ${sizes[i]}` }
  return `${(b / (1024 ** i)).toFixed(1)} ${sizes[i]}`
}

export function calcProgress (totalLength, completedLength) {
  const total = parseInt(totalLength, 10)
  const completed = parseInt(completedLength, 10)
  if (total === 0 || completed === 0) {
    return 0
  }
  const percentage = completed / total * 100
  const result = parseFloat(percentage.toFixed(2))
  return result
}

export function timeRemaining (totalLength, completedLength, downloadSpeed) {
  const remainingLength = totalLength - completedLength
  return Math.ceil(remainingLength / downloadSpeed)
}

/**
 * timeFormat
 * @param {int} seconds
 * @param {string} prefix
 * @param {string} suffix
 * @param {object} i18n
 * i18n: {
 *  gt1d: 'More than one day',
 *  hour: 'h',
 *  minute: 'm',
 *  second: 's'
 * }
 */
export function timeFormat (seconds, { prefix = '', suffix = '', i18n }) {
  let result = ''
  let hours = ''
  let minutes = ''
  let secs = seconds || 0
  const i = {
    gt1d: '> 1 day',
    hour: 'h',
    minute: 'm',
    second: 's',
    ...i18n
  }

  if (secs <= 0) {
    return ''
  }
  if (secs > 86400) {
    return `${prefix} ${i.gt1d} ${suffix}`
  }
  if (secs > 3600) {
    hours = `${Math.floor(secs / 3600)}${i.hour} `
    secs %= 3600
  }
  if (secs > 60) {
    minutes = `${Math.floor(secs / 60)}${i.minute} `
    secs %= 60
  }
  secs += i.second
  result = hours + minutes + secs
  return result ? `${prefix} ${result} ${suffix}` : result
}

export function ellipsis (str = '', maxLen = 64) {
  const len = str.length
  let result = str
  if (len < maxLen) {
    return result
  }

  if (maxLen > 0) {
    result = `${result.substring(0, maxLen)}...`
  }

  return result
}

export function getTaskName (task, options = {}) {
  const o = {
    defaultName: '',
    maxLen: 64, // -1: No limit length
    ...options
  }
  const { defaultName, maxLen } = o
  let result = defaultName
  if (!task) {
    return result
  }

  const { files, bittorrent } = task
  const total = files.length

  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = ellipsis(bittorrent.info.name, maxLen)
  } else if (total === 1) {
    result = getFileName(files[0])
    result = ellipsis(result, maxLen)
  }

  return result
}

export function getFileName (file) {
  if (!file) {
    return ''
  }

  let { path } = file
  if (!path && file.uris && file.uris.length > 0) {
    path = decodeURI(file.uris[0].uri)
  }

  const index = path.lastIndexOf('/')

  if (index <= 0 || index === path.length) {
    return path
  }

  return path.substring(index + 1)
}

export function getTaskFullPath (task) {
  const { dir, files, bittorrent } = task
  let result = dir

  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = `${result}/${bittorrent.info.name}`
    return result
  }

  const [file] = files
  const { path } = file
  let fileName = ''

  if (path) {
    result = path
  } else {
    if (files && files.length === 1) {
      fileName = getFileName(file)
      if (fileName) {
        result = `${result}/${fileName}`
      }
    }
  }

  return result
}

export function getTaskUri (task, btTracker = []) {
  const { files } = task
  let result = ''
  if (checkTaskIsBT(task)) {
    result = buildMagnetLink(task, btTracker)
    return result
  }

  if (files && files.length === 1) {
    const { uris } = files[0]
    result = uris[0].uri
  }

  return result
}

export function buildMagnetLink (task, btTracker = []) {
  const { bittorrent, infoHash } = task
  const { announceList, info } = bittorrent
  const trackers = difference(announceList, btTracker)

  let params = [
    `magnet:?xt=urn:btih:${infoHash}`
  ]
  if (info && info.name) {
    params.push(`dn=${encodeURI(info.name)}`)
  }

  trackers.forEach((tracker) => {
    params.push(`tr=${encodeURI(tracker)}`)
  })

  const result = params.join('&')

  return result
}

export function checkTaskTitleIsEmpty (task) {
  const { files, bittorrent } = task
  const [file] = files
  const { path } = file
  let result = path
  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = bittorrent.info.name
  }
  return result === ''
}

export function checkTaskIsBT (task) {
  const { bittorrent } = task
  return !!bittorrent
}

export function isTorrent (file) {
  const { name, type } = file
  return name.endsWith('.torrent') || type === 'application/x-bittorrent'
}

export function getAsBase64 (file, callback) {
  const reader = new FileReader()
  reader.addEventListener('load', () => {
    // https://developer.mozilla.org/en-US/docs/Web/API/FileReader/readAsDataURL
    const result = reader.result.split('base64,')[1]
    callback(result)
  })
  reader.readAsDataURL(file)
}

export function mergeTaskResult (response = []) {
  let result = []
  for (const res of response) {
    result = result.concat(...res)
  }
  return result
}

export function changeKeysCase (obj, caseConverter) {
  const result = {}
  if (isEmpty(obj) || !isFunction(caseConverter)) {
    return result
  }

  for (const [k, value] of Object.entries(obj)) {
    const key = caseConverter(k)
    result[key] = value
  }

  return result
}

export function changeKeysToCamelCase (obj) {
  return changeKeysCase(obj, camelCase)
}

export function changeKeysToKebabCase (obj) {
  return changeKeysCase(obj, kebabCase)
}

export function validateNumber (n) {
  return !isNaN(parseFloat(n)) && isFinite(n) && Number(n) === n
}

export function fixValue (obj) {
  const result = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === 'true') {
      result[k] = true
    } else if (v === 'false') {
      result[k] = false
    } else if (validateNumber(v)) {
      result[k] = Number(v)
    } else {
      result[k] = v
    }
  }
  return result
}

export function separateConfig (options) {
  // user
  const user = {}
  // system
  const system = {}
  // others
  const others = {}
  for (const [k, v] of Object.entries(options)) {
    if (userKeys.indexOf(k) !== -1) {
      user[k] = v
    } else if (systemKeys.indexOf(k) !== -1) {
      system[k] = v
    } else {
      others[k] = v
    }
  }
  return {
    user, system, others
  }
}

export function compactUndefined (arr = []) {
  return arr.filter((item) => {
    return item !== undefined
  })
}

export function splitTextRows (text = '') {
  return text.replace(/\r\n/g, '\n').split('\n') || []
}

const audioSuffix = ['.aac', '.mp3', '.ogg', '.ape', '.flac', '.m4a', '.wav', '.wma', '.flav']
const videoSuffix = ['.avi', '.mkv', '.rmvb', '.wmv', '.mp4', '.m4a', '.vob', '.mov', '.mpg']
export function isAudioOrVideo (uri = '') {
  const suffixs = [...audioSuffix, ...videoSuffix]
  const result = suffixs.some((suffix) => {
    return uri.includes(suffix)
  })
  return result
}

export function needCheckCopyright (links = '') {
  const uris = splitTaskLinks(links)
  const avs = uris.filter(uri => {
    return isAudioOrVideo(uri)
  })

  const result = avs.length > 0
  return result
}

export function decodeThunderLink (url = '') {
  if (!url.startsWith('thunder://')) {
    return url
  }

  let result = url.split('thunder://')[1]
  result = Buffer.from(result, 'base64').toString('utf8')
  result = result.substring(0, result.length - 2)
  return result
}

export function splitTaskLinks (links = '') {
  const temp = compact(splitTextRows(links))
  const result = temp.map((item) => {
    return decodeThunderLink(item)
  })
  return result
}

const resourceTag = ['http://', 'https://', 'ftp://', 'magnet:', 'thunder://']
export function detectResource (content) {
  return resourceTag.some((type) => {
    return content.includes(type)
  })
}
