'use strict'

module.exports = function promiseEvent (target, event) {
  return new Promise((resolve, reject) => {
    function cleanup () {
      target.removeListener(event, onEvent)
      target.removeListener('error', onError)
    }
    function onEvent (data) {
      resolve(data)
      cleanup()
    }
    function onError (err) {
      reject(err)
      cleanup()
    }
    target.addListener(event, onEvent)
    target.addListener('error', onError)
  })
}
