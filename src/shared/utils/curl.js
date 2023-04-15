import * as curlParser from '@bany/curl-to-json'

export const buildUrisFromCurl = (uris = []) => {
  return uris.map((uri) => {
    if (uri.startsWith('curl')) {
      const parsedUri = curlParser(uri)
      uri = parsedUri.url
      if (parsedUri.params && Object.keys(parsedUri.params).length > 0) {
        const paramsStr = Object.keys(parsedUri.params)
          .map((k) => `${k}=${parsedUri.params[k]}`)
          .join('&')
        uri = `${uri}?${paramsStr}`
      }
      return uri
    } else {
      return uri
    }
  })
}

export const buildHeadersFromCurl = (uris = []) => {
  return uris.map((uri) => {
    if (uri.startsWith('curl')) {
      const parsed = curlParser(uri)
      const header = parsed.header ?? {}
      if (parsed.cookie) {
        header.cookie = parsed.cookie
      }
      if (parsed['user-agent']) {
        header['user-agent'] = parsed['user-agent']
      }
      if (parsed.referer) {
        header.referer = parsed.referer
      }
      return header
    } else {
      return undefined
    }
  })
}

export const buildDefaultOptionsFromCurl = (form, headers = []) => {
  const firstNonNullHeader = headers.find((elem) => elem)
  if (firstNonNullHeader) {
    form.cookie = !form.cookie && firstNonNullHeader.cookie ? firstNonNullHeader.cookie : form.cookie
    form.referer = !form.referer && firstNonNullHeader.referer ? firstNonNullHeader.referer : form.referer
    form.userAgent = !form.userAgent && firstNonNullHeader['user-agent'] ? firstNonNullHeader['user-agent'] : form.userAgent
    form.authorization = !form.authorization && firstNonNullHeader.authorization ? firstNonNullHeader.authorization : form.authorization
  }
  return form
}
