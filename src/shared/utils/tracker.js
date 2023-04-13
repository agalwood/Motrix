import { isEmpty } from 'lodash'
import axios from 'axios'
import { MAX_BT_TRACKER_LENGTH } from '@shared/constants'

export const fetchBtTrackerFromSource = async (source) => {
  if (isEmpty(source)) {
    return []
  }

  const now = Date.now()
  const promises = source.map((url) => {
    return axios.get(`${url}?t=${now}`).then((value) => value.data)
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
