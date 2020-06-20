import {
  isEmpty
} from 'lodash'
import axios from 'axios'

import { EMPTY_STRING } from '@shared/constants'

export const fetchBtTrackerFromSource = async (source) => {
  if (isEmpty(source)) {
    return EMPTY_STRING
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

export function convertTrackerDataToLine (arr = []) {
  const result = arr.join('\r\n').replace(/^\s*[\r\n]/gm, '').trim()
  return result
}

export function convertTrackerDataToComma (arr = []) {
  const result = convertTrackerDataToLine(arr).replace(/(?:\r\n|\r|\n)/g, ',').trim()
  return result
}
