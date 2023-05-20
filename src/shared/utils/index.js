import {
  camelCase,
  compact,
  difference,
  isArray,
  isEmpty,
  isFunction,
  isNaN,
  isPlainObject,
  kebabCase,
  omitBy,
  parseInt,
  pick
} from 'lodash'
import bitTorrentPeerId from 'bittorrent-peerid'

import { userKeys, systemKeys, needRestartKeys } from '@shared/configKeys'
import {
  APP_THEME,
  ENGINE_RPC_HOST,
  GRAPHIC,
  NONE_SELECTED_FILES,
  SELECTED_ALL_FILES,
  RESOURCE_TAGS,
  IMAGE_SUFFIXES,
  AUDIO_SUFFIXES,
  VIDEO_SUFFIXES,
  SUB_SUFFIXES,
  UNKNOWN_PEERID,
  SUPPORT_RTL_LOCALES,
  UNKNOWN_PEERID_NAME,
  DOCUMENT_SUFFIXES
} from '@shared/constants'

export const bytesToSize = (bytes, precision = 1) => {
  const b = parseInt(bytes, 10)
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  if (b === 0) { return '0 KB' }
  const i = parseInt(Math.floor(Math.log(b) / Math.log(1024)), 10)
  if (i === 0) { return `${b} ${sizes[i]}` }
  return `${(b / (1024 ** i)).toFixed(precision)} ${sizes[i]}`
}

export const extractSpeedUnit = (speed = '') => {
  if (parseInt(speed) === 0) {
    return 'K'
  }

  const regex = /^(\d+\.?\d*)([KMG])$/
  const match = regex.exec(speed)

  if (!match) {
    return 'K'
  }

  return match[2]
}

export const bitfieldToPercent = (text) => {
  const len = text.length - 1
  let p
  let one = 0
  for (let i = 0; i < len; i++) {
    p = parseInt(text[i], 16)
    for (let j = 0; j < 4; j++) {
      one += (p & 1)
      p >>= 1
    }
  }
  return Math.floor(one / (4 * len) * 100).toString()
}

export const bitfieldToGraphic = (text) => {
  const len = text.length
  let result = ''
  for (let i = 0; i < len; i++) {
    result += GRAPHIC[Math.floor(parseInt(text[i], 16) / 4)] + ' '
  }
  return result
}

export const peerIdParser = (str) => {
  if (!str || str === UNKNOWN_PEERID) {
    return UNKNOWN_PEERID_NAME
  }

  let parsed = {}
  let decodedStr
  try {
    // decodeURI or decodeURIComponent cannot parse '%2DUT360W%2D%92%B6%EBh%1F%A1%DBfo%F6%D5I'
    decodedStr = unescape(str)
    const buffer = Buffer.from(decodedStr, 'binary')
    parsed = bitTorrentPeerId(buffer)
  } catch (e) {
    console.log('peerIdParser.fail', e, str, decodedStr)
    return UNKNOWN_PEERID_NAME
  }

  const result = parsed.version
    ? `${parsed.client} v${parsed.version}`
    : parsed.client
  return result
}

export const calcProgress = (totalLength, completedLength, decimal = 2) => {
  const total = parseInt(totalLength, 10)
  const completed = parseInt(completedLength, 10)
  if (total === 0 || completed === 0) {
    return 0
  }
  const percentage = completed / total * 100
  const result = parseFloat(percentage.toFixed(decimal))
  return result
}

export const calcRatio = (totalLength, uploadLength) => {
  const total = parseInt(totalLength, 10)
  const upload = parseInt(uploadLength, 10)
  if (total === 0 || upload === 0) {
    return 0
  }

  const percentage = upload / total
  const result = parseFloat(percentage.toFixed(4))
  return result
}

export const timeRemaining = (totalLength, completedLength, downloadSpeed) => {
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
export const timeFormat = (seconds, { prefix = '', suffix = '', i18n }) => {
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

export const localeDateTimeFormat = (timestamp, locale) => {
  if (!timestamp) {
    return ''
  }

  if (`${timestamp}`.length === 10) {
    timestamp *= 1000
  }
  const date = new Date(timestamp)
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  })
}

export const ellipsis = (str = '', maxLen = 64) => {
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

export const getFileSelection = (files = []) => {
  console.log('getFileSelection===>', files)
  const selectedFiles = files.filter((file) => file.selected)
  if (files.length === 0 || selectedFiles.length === 0) {
    return NONE_SELECTED_FILES
  }

  if (files.length === selectedFiles.length) {
    return SELECTED_ALL_FILES
  }

  const indexArr = []
  files.forEach((_, index) => {
    indexArr.push(index)
  })
  const result = indexArr.join(',')
  return result
}

export const getTaskName = (task, options = {}) => {
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
    result = getFileNameFromFile(files[0])
    result = ellipsis(result, maxLen)
  }

  return result
}

export const getFileNameFromFile = (file) => {
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

export const isMagnetTask = (task) => {
  const { bittorrent } = task
  return bittorrent && !bittorrent.info
}

export const checkTaskIsSeeder = (task) => {
  const { bittorrent, seeder } = task
  return !!bittorrent && seeder === 'true'
}

export const getTaskUri = (task, withTracker = false) => {
  const { files } = task
  let result = ''
  if (checkTaskIsBT(task)) {
    result = buildMagnetLink(task, withTracker)
    return result
  }

  if (files && files.length === 1) {
    const { uris } = files[0]
    result = uris[0].uri
  }

  return result
}

export const buildMagnetLink = (task, withTracker = false, btTracker = []) => {
  const { bittorrent, infoHash } = task
  const { info } = bittorrent

  const params = [
    `magnet:?xt=urn:btih:${infoHash}`
  ]
  if (info && info.name) {
    params.push(`dn=${encodeURI(info.name)}`)
  }

  if (withTracker) {
    const trackers = difference(bittorrent.announceList, btTracker)
    trackers.forEach((tracker) => {
      params.push(`tr=${encodeURI(tracker)}`)
    })
  }

  const result = params.join('&')

  return result
}

export const checkTaskTitleIsEmpty = (task) => {
  const { files, bittorrent } = task
  const [file] = files
  const { path } = file
  let result = path
  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = bittorrent.info.name
  }
  return result === ''
}

export const checkTaskIsBT = (task = {}) => {
  const { bittorrent } = task
  return !!bittorrent
}

export const isTorrent = (file) => {
  const { name, type } = file
  return name.endsWith('.torrent') || type === 'application/x-bittorrent'
}

export const getAsBase64 = (file, callback) => {
  const reader = new FileReader()
  reader.addEventListener('load', () => {
    // https://developer.mozilla.org/en-US/docs/Web/API/FileReader/readAsDataURL
    const result = reader.result.split('base64,')[1]
    callback(result)
  })
  reader.readAsDataURL(file)
}

export const mergeTaskResult = (response = []) => {
  let result = []
  for (const res of response) {
    result = result.concat(...res)
  }
  return result
}

export const changeKeysCase = (obj, caseConverter) => {
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

export const changeKeysToCamelCase = (obj = {}) => {
  return changeKeysCase(obj, camelCase)
}

export const changeKeysToKebabCase = (obj = {}) => {
  return changeKeysCase(obj, kebabCase)
}

export const validateNumber = (n) => {
  return !isNaN(parseFloat(n)) && isFinite(n) && Number(n) === n
}

export const fixValue = (obj = {}) => {
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

export const separateConfig = (options) => {
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

export const compactUndefined = (arr = []) => {
  return arr.filter((item) => {
    return item !== undefined
  })
}

export const splitTextRows = (text = '') => {
  text = `${text}`
  let result = text
    .replace(/(?:\\\r\\\n|\\\r|\\\n)/g, ' ')
    .replace(/(?:\r\n|\r|\n)/g, '\n')
    .split('\n') || []
  result = result.map((row) => row.trim())
  return result
}

export const convertCommaToLine = (text = '') => {
  text = `${text}`
  let arr = text.split(',')
  arr = arr.map((row) => row.trim())
  const result = arr.join('\n').trim()
  return result
}

export const convertLineToComma = (text = '') => {
  const result = text.trim().replace(/(?:\r\n|\r|\n)/g, ',')
  return result
}

export const filterVideoFiles = (files = []) => {
  const suffix = [...VIDEO_SUFFIXES, ...SUB_SUFFIXES]
  return files.filter((item) => {
    return suffix.includes(item.extension)
  })
}

export const filterAudioFiles = (files = []) => {
  return files.filter((item) => {
    return AUDIO_SUFFIXES.includes(item.extension)
  })
}

export const filterImageFiles = (files = []) => {
  return files.filter((item) => {
    return IMAGE_SUFFIXES.includes(item.extension)
  })
}

export const filterDocumentFiles = (files = []) => {
  return files.filter((item) => {
    return DOCUMENT_SUFFIXES.includes(item.extension)
  })
}

export const isAudioOrVideo = (uri = '') => {
  const suffixs = [...AUDIO_SUFFIXES, ...VIDEO_SUFFIXES]
  const result = suffixs.some((suffix) => {
    return uri.includes(suffix)
  })
  return result
}

export const needCheckCopyright = (links = '') => {
  const uris = splitTaskLinks(links)
  const avs = uris.filter(uri => {
    return isAudioOrVideo(uri)
  })

  const result = avs.length > 0
  return result
}

export const decodeThunderLink = (url = '') => {
  if (!url.startsWith('thunder://')) {
    return url
  }

  let result = url.trim()
  result = result.split('thunder://')[1]
  result = Buffer.from(result, 'base64').toString('utf8')
  result = result.substring(2, result.length - 2)
  return result
}

export const splitTaskLinks = (links = '') => {
  const temp = compact(splitTextRows(links))
  const result = temp.map((item) => {
    return decodeThunderLink(item)
  })
  return result
}

export const detectResource = (content) => {
  return RESOURCE_TAGS.some((type) => {
    return content.includes(type)
  })
}

export const buildFileList = (rawFile) => {
  rawFile.uid = Date.now()
  const file = {
    status: 'ready',
    name: rawFile.name,
    size: rawFile.size,
    percentage: 0,
    uid: rawFile.uid,
    raw: rawFile
  }
  const fileList = [file]
  return fileList
}

export const isRTL = (locale = 'en-US') => {
  return SUPPORT_RTL_LOCALES.includes(locale)
}

export const getLangDirection = (locale = 'en-US') => {
  return isRTL(locale) ? 'rtl' : 'ltr'
}

export const listTorrentFiles = (files) => {
  const result = files.map((file, index) => {
    const extension = getFileExtension(file.path)
    const item = {
      // aria2 select-file start index at 1
      // possible Values: 1-1048576
      idx: index + 1,
      extension: `.${extension}`,
      ...file
    }
    return item
  })
  return result
}

export const getFileName = (fullPath) => {
  // eslint-disable-next-line
  return fullPath.replace(/^.*[\\\/]/, '')
}

export const getFileExtension = (filename) => {
  return filename.slice((filename.lastIndexOf('.') - 1 >>> 0) + 2)
}

export const removeExtensionDot = (extension = '') => {
  return extension.replace('.', '')
}

export const diffConfig = (current = {}, next = {}) => {
  const curr = pick(current, Object.keys(next))
  const result = omitBy(next, (val, key) => {
    if (isArray(val) || isPlainObject(val)) {
      return JSON.stringify(curr[key]) === JSON.stringify(val)
    }
    return curr[key] === val
  })

  return result
}

export const calcFormLabelWidth = (locale) => {
  return locale.startsWith('de') ? '28%' : '25%'
}

export const parseHeader = (header = '') => {
  header = header.trim()
  let result = {}
  if (!header) {
    return result
  }

  const headers = splitTextRows(header)
  headers.forEach((line) => {
    const index = line.indexOf(':')
    const name = line.substring(0, index)
    const value = line.substring(index + 1).trim()
    result[name] = value
  })
  result = changeKeysToCamelCase(result)

  return result
}

export const formatOptionsForEngine = (options = {}) => {
  const result = {}

  Object.keys(options).forEach((key) => {
    const kebabCaseKey = kebabCase(key)
    if (Array.isArray(options[key])) {
      result[kebabCaseKey] = options[key].join('\n')
    } else {
      result[kebabCaseKey] = `${options[key]}`
    }
  })

  return result
}

export const buildRpcUrl = (options = {}) => {
  const { port, secret } = options
  let result = `${ENGINE_RPC_HOST}:${port}/jsonrpc`
  if (secret) {
    result = `token:${secret}@${result}`
  }
  result = `http://${result}`

  return result
}

export const checkIsNeedRestart = (changed = {}) => {
  let result = false

  if (isEmpty(changed)) {
    return result
  }

  const kebabCaseChanged = changeKeysToKebabCase(changed)
  needRestartKeys.some((key) => {
    if (Object.keys(kebabCaseChanged).includes(key)) {
      result = true
      return true
    }
    return false
  })

  return result
}

export const checkIsNeedRun = (enable, lastTime, interval) => {
  if (!enable) {
    return false
  }

  return (Date.now() - lastTime > interval)
}

export const generateRandomInt = (min = 0, max = 10000) => {
  let result = min
  const range = max - min
  result += Math.floor(Math.random() * Math.floor(range))
  return result
}

export const intersection = (array1 = [], array2 = []) => {
  if (array1.length === 0 || array2.length === 0) {
    return []
  }

  return array1.filter(value => array2.includes(value))
}

export const cloneArray = (arr = [], reversed = false) => {
  if (!Array.isArray(arr)) {
    return arr
  }

  const result = [...arr]
  return reversed ? result.reverse() : result
}

export const pushItemToFixedLengthArray = (arr = [], maxLength, item) => {
  const result = arr.length >= maxLength
    ? [...arr.slice(1, maxLength - 1), item]
    : [...arr, item]
  return result
}

export const removeArrayItem = (arr = [], item) => {
  const idx = arr.indexOf(item)
  if (idx === -1) {
    return [...arr]
  }

  const result = [
    ...arr.slice(0, idx),
    ...arr.slice(idx + 1)
  ]
  return result
}

export const getInverseTheme = (theme) => {
  return (theme === APP_THEME.LIGHT) ? APP_THEME.DARK : APP_THEME.LIGHT
}

export const changedConfig = { basic: {}, advanced: {} }
export const backupConfig = { theme: undefined, locale: undefined }
