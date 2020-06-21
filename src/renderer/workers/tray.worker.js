/* eslint no-unused-vars: 'off' */
import { TRAY_CANVAS_CONFIG } from '@shared/constants'
import { draw } from '@shared/utils/tray'

let idx = 0
let canvas

const initCanvas = () => {
  if (canvas) {
    return canvas
  }

  const { WIDTH, HEIGHT } = TRAY_CANVAS_CONFIG
  return new OffscreenCanvas(WIDTH, HEIGHT)
}

const drawTray = async (payload) => {
  self.postMessage({
    type: 'log',
    payload
  })

  if (!canvas) {
    canvas = initCanvas()
  }

  try {
    const tray = await draw({
      canvas,
      ...payload
    })

    self.postMessage({
      type: 'tray:drawed',
      payload: {
        idx,
        tray
      }
    })

    idx += 1
  } catch (error) {
    logger(error.message)
  }
}

const logger = (text) => {
  self.postMessage({
    type: 'log',
    payload: text
  })
}

self.postMessage({
  type: 'initialized',
  payload: Date.now()
})

self.addEventListener('message', (event) => {
  const { type, payload } = event.data
  switch (type) {
  case 'tray:draw':
    drawTray(payload)
    break
  default:
    logger(JSON.stringify(event.data))
  }
})
