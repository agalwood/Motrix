'use strict'

import { inspect } from 'util'

module.exports = (aria2) => {
  aria2.on('open', () => {
    console.log('aria2', 'OPEN')
  })

  aria2.on('close', () => {
    console.log('aria2', 'CLOSE')
  })

  aria2.on('input', (m) => {
    console.log('aria2', 'IN')
    console.log(inspect(m, { depth: null, colors: true }))
  })

  aria2.on('output', (m) => {
    console.log('aria2', 'OUT')
    console.log(inspect(m, { depth: null, colors: true }))
  })
}
