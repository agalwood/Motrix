import {
  isEmpty
} from 'lodash'
import { EMPTY_STRING } from '@shared/constants'
import axios from 'axios'

export const fetchBtTrackerFromSource = async (source) => {
  if (isEmpty(source)) {
    return EMPTY_STRING
  }

  const now = Date.now()
  const promises = source.map((url) => {
    return axios.get(`${url}?t=${now}`).then((value) => value.data)
  })

  const resp = await Promise.all(promises)
  const result = [...new Set(resp)]
  return result
}

export function convertTrackerDataToLine (arr = []) {
  const result = arr.join('\r\n').replace(/^\s*[\r\n]/gm, '')
  return result
}

export function convertTrackerDataToComma (arr = []) {
  const result = convertTrackerDataToLine(arr).trim().replace(/(?:\r\n|\r|\n)/g, ',')
  return result
}
