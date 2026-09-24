import {
  WEB_EVENT_HEARTBEAT,
  WEB_EVENT_HEARTBEAT_MS,
  WEB_EVENT_STALE_MS,
} from '@shared/schemas/web-event-stream'
import type WebSocket from 'ws'

/** Control-frame pongs are answered by the browser even in a hidden tab.
 * The JSON heartbeat lets browser JavaScript observe server liveness too. */
export function bindEventHeartbeat(socket: WebSocket): () => void {
  let lastPong = Date.now()
  const onPong = () => {
    lastPong = Date.now()
  }
  socket.on('pong', onPong)
  const send = () => {
    if (Date.now() - lastPong >= WEB_EVENT_STALE_MS) {
      socket.terminate()
      return
    }
    try {
      socket.send(JSON.stringify(WEB_EVENT_HEARTBEAT), (error) => {
        if (error) socket.terminate()
      })
      socket.ping()
    } catch {
      socket.terminate()
    }
  }
  const timer = setInterval(send, WEB_EVENT_HEARTBEAT_MS)
  timer.unref()
  send()
  return () => {
    clearInterval(timer)
    socket.off('pong', onPong)
  }
}
