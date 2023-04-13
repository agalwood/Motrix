import * as curlParser from '@bany/curl-to-json'

export const buildUrisFromCurl = (uris = []) => {
  return uris.map((uri) => uri.startsWith('curl') ? curlParser(uri).url : uri)
}

export const buildHeadersFromCurl = (uris = []) => {
  return uris.map((uri) => uri.startsWith('curl') ? curlParser(uri).header : undefined)
}

export const buildDefaultOptionsFromCurl = (form, headers = []) => {
  const firstNonNullHeader = headers.find((elem) => elem)
  if (firstNonNullHeader) {
    form.cookie = !form.cookie ? firstNonNullHeader.cookie : form.cookie
    form.referer = !form.referer ? firstNonNullHeader.referer : form.referer
    form.userAgent = !form.userAgent ? firstNonNullHeader['user-agent'] : form.userAgent
    form.authorization = !form.authorization ? firstNonNullHeader.authorization : form.authorization
  }
  return form
}
