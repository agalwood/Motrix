import is from 'electron-is'

export default {
  index: {
    attrs: {
      title: 'Motrix',
      width: 1024,
      height: 768,
      minWidth: 840,
      minHeight: 420,
      // backgroundColor: '#FFFFFF',
      transparent: true
    },
    bindCloseToHide: true,
    url: is.dev() ? `http://localhost:9080` : `file://${__dirname}/index.html`
  },
  about: {
    attrs: {
      title: '关于',
      width: 580,
      height: 320,
      backgroundColor: '#FFFFFF',
      resizable: false,
      minimizable: false,
      maximizable: false
    },
    url: is.dev() ? `http://localhost:9080/about` : `file://${__dirname}/about.html`
  }
}
