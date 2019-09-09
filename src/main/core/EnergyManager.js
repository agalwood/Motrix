import { powerSaveBlocker } from 'electron'

let psbId
export default class EnergyManager {
  startPowerSaveBlocker () {
    if (psbId && powerSaveBlocker.isStarted(psbId)) {
      return
    }

    psbId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('startPowerSaveBlocker===>', psbId)
  }

  stopPowerSaveBlocker () {
    if (typeof psbId === 'undefined' || !powerSaveBlocker.isStarted(psbId)) {
      return
    }

    powerSaveBlocker.stop(psbId)
    console.log('stopPowerSaveBlocker===>', psbId)
    psbId = undefined
  }
}
