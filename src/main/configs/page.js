import is from 'electron-is'

export default {
  index: {
    attrs: {
      title: 'Motrix',
      width: 1024,
      height: 768,
      minWidth: 478,
      minHeight: 420,
      transparent: is.macOS()
    },
    bindCloseToHide: true,
    openDevTools: is.dev(),
    url: is.dev() ? 'http://localhost:9080' : require('path').join('file://', __dirname, '/index.html')
  }
}
