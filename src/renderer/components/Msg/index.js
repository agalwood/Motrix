const queue = []
const maxLength = 5

export default {
  install: function (Vue, Message, defaultOption = {}) {
    Vue.prototype.$msg = new Proxy(Message, {
      get (obj, prop) {
        return (arg) => {
          if (!(arg instanceof Object)) {
            arg = { message: arg }
          }
          const task = {
            run () {
              obj[prop]({
                ...defaultOption,
                ...arg,
                onClose (...data) {
                  const currentTask = queue.pop()
                  if (currentTask) {
                    currentTask.run()
                  }
                  if (arg.onClose) {
                    arg.onClose(...data)
                  }
                }
              })
            }
          }

          if (queue.length >= maxLength) {
            queue.pop()
          }
          queue.unshift(task)

          if (queue.length === 1) {
            queue.pop().run()
          }
        }
      }
    })
  }
}
