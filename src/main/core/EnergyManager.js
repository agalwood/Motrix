import { powerSaveBlocker } from 'electron'

let psbId = null
export default class EnergyManager {
  startPowerSaveBlocker () {
    if (psbId && powerSaveBlocker.isStarted(psbId)) {
      return
    }

    psbId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('startPowerSaveBlocker===>', psbId)
  }

  stopPowerSaveBlocker () {
    if (!psbId || !powerSaveBlocker.isStarted(psbId)) {
      return
    }

    powerSaveBlocker.stop(psbId)
    console.log('stopPowerSaveBlocker===>', psbId)
    psbId = null
  }
}
