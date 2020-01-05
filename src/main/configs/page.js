import is from 'electron-is'

export default {
  index: {
    attrs: {
      title: 'Motrix',
      width: 1024,
      height: 768,
      minWidth: 400,
      minHeight: 420,
      // backgroundColor: '#FFFFFF',
      transparent: !is.windows()
    },
    bindCloseToHide: true,
    url: is.dev() ? `http://localhost:9080` : `file://${__dirname}/index.html`
  }
}
