import axios from 'axios'
import htmlparser from 'htmlparser2'
import urlParser from 'url-parse'
import prettyBytes from 'pretty-bytes'

let scrapOrigin = null
let files = []

const fetchFileHead = async (url) => {
  const response = await axios.head(url)
  const size = () => {
    if (response.headers.hasOwnProperty('content-length')) {
      const contentLength = parseInt(response.headers['content-length'])
      return prettyBytes(contentLength)
    } else {
      return '-'
    }
  }
  const type = () => {
    return response.headers['content-type']
  }

  return {
    size: size(),
    type: type()
  }
}

const sanitizeUrl = (url) => {
  return `${scrapOrigin}${urlParser(url).pathname}`
}

const parseElement = async (tag, attr) => {
  const cssUrlRegex = /url\(("|')?(\S)*("|')?\)/g
  let url = null

  if (attr.href && tag !== 'a') {
    console.log(`HREF: [${tag}] ${attr.href} (${attr.rel || attr.title})`)
    url = sanitizeUrl(attr.href)
  } else if (attr.src && tag !== 'script') {
    console.log(`SRC: [${tag}] ${attr.src} (${attr.alt || attr.title})`)
    url = sanitizeUrl(attr.src)
  } else if (attr.style && attr.style.match(cssUrlRegex)) {
    attr.style.match(cssUrlRegex).forEach(x => console.log(`CSS-RES: [style] ${cssUrl(x)}`))
  }

  // add url
  if (url) {
    let item = {
      url,
      name: url.substr(url.lastIndexOf('/') + 1),
      ...await fetchFileHead(url)
    }
    files.push(item)
    scrapCallback(files)
  }
}
let scrapCallback = (f) => {}
const scrap = async (url, cb) => {
  scrapOrigin = urlParser(url).origin
  files = []
  scrapCallback = cb
  const response = await axios.get(url)
  parser.end(response.data)
}

const cssUrl = (value) => {
  return value.replace(/.*url\(("|')?/g, '').replace(/("|')?\).*/g, '')
}

const parser = new htmlparser.Parser({
  onopentag: (t, a) => parseElement(t, a)
}, { decodeEntities: true })

export default scrap
