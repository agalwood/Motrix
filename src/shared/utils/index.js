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
  UNKNOWN_PEERID_NAME
} from '@shared/constants'

export function bytesToSize (bytes, precision = 1) {
  const b = parseInt(bytes, 10)
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  if (b === 0) { return '0 KB' }
  const i = parseInt(Math.floor(Math.log(b) / Math.log(1024)), 10)
  if (i === 0) { return `${b} ${sizes[i]}` }
  return `${(b / (1024 ** i)).toFixed(precision)} ${sizes[i]}`
}

export function bitfieldToPercent (text) {
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

export function bitfieldToGraphic (text) {
  const len = text.length
  let result = ''
  for (let i = 0; i < len; i++) {
    result += GRAPHIC[Math.floor(parseInt(text[i], 16) / 4)] + ' '
  }
  return result
}

export function peerIdParser (str) {
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

export function calcRatio (totalLength, uploadLength) {
  const total = parseInt(totalLength, 10)
  const upload = parseInt(uploadLength, 10)
  if (total === 0 || upload === 0) {
    return 0
  }

  const percentage = upload / total
  const result = parseFloat(percentage.toFixed(4))
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

export function localeDateTimeFormat (timestamp, locale) {
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

export function getFileSelection (files = []) {
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
    result = getFileNameFromFile(files[0])
    result = ellipsis(result, maxLen)
  }

  return result
}

export function getFileNameFromFile (file) {
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

export function isMagnetTask (task) {
  const { bittorrent } = task
  return bittorrent && !bittorrent.info
}

export function checkTaskIsSeeder (task) {
  const { bittorrent, seeder } = task
  return !!bittorrent && seeder === 'true'
}

export function getTaskUri (task, withTracker = false) {
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

export function buildMagnetLink (task, withTracker = false, btTracker = []) {
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

export function checkTaskIsBT (task = {}) {
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

export function changeKeysToCamelCase (obj = {}) {
  return changeKeysCase(obj, camelCase)
}

export function changeKeysToKebabCase (obj = {}) {
  return changeKeysCase(obj, kebabCase)
}

export function validateNumber (n) {
  return !isNaN(parseFloat(n)) && isFinite(n) && Number(n) === n
}

export function fixValue (obj = {}) {
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
  let result = text.replace(/(?:\r\n|\r|\n)/g, '\n').split('\n') || []
  result = result.map((row) => row.trim())
  return result
}

export function convertCommaToLine (text = '') {
  let arr = text.split(',')
  arr = arr.map((row) => row.trim())
  const result = arr.join('\n').trim()
  return result
}

export function convertLineToComma (text = '') {
  const result = text.trim().replace(/(?:\r\n|\r|\n)/g, ',')
  return result
}

export function filterVideoFiles (files = []) {
  const suffix = [...VIDEO_SUFFIXES, ...SUB_SUFFIXES]
  return files.filter((item) => {
    return suffix.includes(item.extension)
  })
}

export function filterAudioFiles (files = []) {
  return files.filter((item) => {
    return AUDIO_SUFFIXES.includes(item.extension)
  })
}

export function filterImageFiles (files = []) {
  return files.filter((item) => {
    return IMAGE_SUFFIXES.includes(item.extension)
  })
}

export function isAudioOrVideo (uri = '') {
  const suffixs = [...AUDIO_SUFFIXES, ...VIDEO_SUFFIXES]
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

  let result = url.trim()
  result = result.split('thunder://')[1]
  result = Buffer.from(result, 'base64').toString('utf8')
  result = result.substring(2, result.length - 2)
  return result
}

export function splitTaskLinks (links = '') {
  const temp = compact(splitTextRows(links))
  const result = temp.map((item) => {
    return decodeThunderLink(item)
  })
  return result
}

export function detectResource (content) {
  return RESOURCE_TAGS.some((type) => {
    return content.includes(type)
  })
}

export function buildFileList (rawFile) {
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

export function isRTL (locale = 'en-US') {
  return SUPPORT_RTL_LOCALES.includes(locale)
}

export function getLangDirection (locale = 'en-US') {
  return isRTL(locale) ? 'rtl' : 'ltr'
}

export function listTorrentFiles (files) {
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

export function getFileName (fullPath) {
  // eslint-disable-next-line
  return fullPath.replace(/^.*[\\\/]/, '')
}

export function getFileExtension (filename) {
  return filename.slice((filename.lastIndexOf('.') - 1 >>> 0) + 2)
}

export function removeExtensionDot (extension = '') {
  return extension.replace('.', '')
}

export function diffConfig (current = {}, next = {}) {
  const curr = pick(current, Object.keys(next))
  const result = omitBy(next, (val, key) => {
    if (isArray(val) || isPlainObject(val)) {
      return JSON.stringify(curr[key]) === JSON.stringify(val)
    }
    return curr[key] === val
  })
  return result
}

export function calcFormLabelWidth (locale) {
  return locale.startsWith('de') ? '28%' : '25%'
}

export function parseHeader (header = '') {
  header = header.trim()
  let result = {}
  if (!header) {
    return result
  }

  const headers = splitTextRows(header)
  headers.forEach((line) => {
    const index = line.indexOf(':')
    const name = line.substr(0, index)
    const value = line.substr(index + 1).trim()
    result[name] = value
  })
  result = changeKeysToCamelCase(result)

  return result
}

export function formatOptionsForEngine (options = {}) {
  const result = {}

  Object.keys(options).forEach((key) => {
    const kebabCaseKey = kebabCase(key)
    result[kebabCaseKey] = `${options[key]}`
  })

  return result
}

export function buildRpcUrl (options = {}) {
  const { port, secret } = options
  let result = `${ENGINE_RPC_HOST}:${port}/jsonrpc`
  if (secret) {
    result = `token:${secret}@${result}`
  }
  result = `http://${result}`

  return result
}

export function checkIsNeedRestart (changed = {}) {
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

export const getInverseTheme = (theme) => {
  return (theme === APP_THEME.LIGHT) ? APP_THEME.DARK : APP_THEME.LIGHT
}

export const changedConfig = { basic: {}, advanced: {} }
export const backupConfig = { theme: undefined, locale: undefined }
