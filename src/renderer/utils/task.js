import { isEmpty } from 'lodash'

import {
  ADD_TASK_TYPE,
  NONE_SELECTED_FILES,
  SELECTED_ALL_FILES
} from '@shared/constants'
import { splitTaskLinks } from '@shared/utils'
import { buildOuts } from '@shared/utils/rename'

import {
  buildUrisFromCurl,
  buildHeadersFromCurl,
  buildDefaultOptionsFromCurl
} from '@shared/utils/curl'

export const initTaskForm = state => {
  const { addTaskUrl, addTaskOptions } = state.app
  const {
    allProxy,
    dir,
    engineMaxConnectionPerServer,
    followMetalink,
    followTorrent,
    maxConnectionPerServer,
    newTaskShowDownloading,
    split
  } = state.preference.config
  const result = {
    allProxy,
    cookie: '',
    dir,
    engineMaxConnectionPerServer,
    followMetalink,
    followTorrent,
    maxConnectionPerServer,
    newTaskShowDownloading,
    out: '',
    referer: '',
    selectFile: NONE_SELECTED_FILES,
    split,
    torrent: '',
    uris: addTaskUrl,
    userAgent: '',
    authorization: '',
    ...addTaskOptions
  }
  return result
}

export const buildHeader = (form) => {
  const { userAgent, referer, cookie, authorization } = form
  const result = []

  if (!isEmpty(userAgent)) {
    result.push(`User-Agent: ${userAgent}`)
  }
  if (!isEmpty(referer)) {
    result.push(`Referer: ${referer}`)
  }
  if (!isEmpty(cookie)) {
    result.push(`Cookie: ${cookie}`)
  }
  if (!isEmpty(authorization)) {
    result.push(`Authorization: ${authorization}`)
  }

  return result
}

export const buildOption = (type, form) => {
  const {
    allProxy,
    dir,
    out,
    selectFile,
    split
  } = form
  const result = {}

  if (!isEmpty(allProxy)) {
    result.allProxy = allProxy
  }

  if (!isEmpty(dir)) {
    result.dir = dir
  }

  if (!isEmpty(out)) {
    result.out = out
  }

  if (split > 0) {
    result.split = split
  }

  if (type === ADD_TASK_TYPE.TORRENT) {
    if (
      selectFile !== SELECTED_ALL_FILES &&
      selectFile !== NONE_SELECTED_FILES
    ) {
      result.selectFile = selectFile
    }
  }

  const header = buildHeader(form)
  if (!isEmpty(header)) {
    result.header = header
  }

  return result
}

export const buildUriPayload = (form) => {
  let { uris, out } = form
  if (isEmpty(uris)) {
    throw new Error('task.new-task-uris-required')
  }

  uris = splitTaskLinks(uris)
  const curlHeaders = buildHeadersFromCurl(uris)
  uris = buildUrisFromCurl(uris)
  const outs = buildOuts(uris, out)

  form = buildDefaultOptionsFromCurl(form, curlHeaders)

  const options = buildOption(ADD_TASK_TYPE.URI, form)
  const result = {
    uris,
    outs,
    options
  }
  return result
}

export const buildTorrentPayload = (form) => {
  const { torrent } = form
  if (isEmpty(torrent)) {
    throw new Error('task.new-task-torrent-required')
  }

  const options = buildOption(ADD_TASK_TYPE.TORRENT, form)
  const result = {
    torrent,
    options
  }
  return result
}
