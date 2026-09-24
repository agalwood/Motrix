import { commands } from 'motrix:plugin-api'

let intervalId

commands.register('test.timer-activity.timeout', ({ delay }) => {
  setTimeout(() => {}, delay)
  return true
})

commands.register('test.timer-activity.interval', ({ delay }) => {
  intervalId = setInterval(() => {}, delay)
  return true
})

commands.register('test.timer-activity.clear', () => {
  if (intervalId !== undefined) clearInterval(intervalId)
  intervalId = undefined
  return true
})
