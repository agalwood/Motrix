export default {
  install: function (Vue, Message, defaultOption = {}) {
    Vue.prototype.$msg = new Proxy(Message, {
      get (obj, prop) {
        return (arg) => {
          if (arg instanceof String) {
            arg = { message: arg }
          }
          obj[prop]({
            ...defaultOption,
            ...arg
          })
        }
      }
    })
  }
}
