import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { SettingsManager } from '@core/settings/settings-manager'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNatManager } from '../../src/main/nat/nat-manager-factory'
import {
  type FakeUpnpRouter,
  startFakeUpnpRouter,
} from './helpers/fake-upnp-router'

// This suite binds SSDP port 1900 and uses real OS networking; skip unless
// explicitly opted in. CI / manual runs set NAT_E2E=1.
const SKIP = process.env.NAT_E2E !== '1'

describe.skipIf(SKIP)(
  'NatManager main-process E2E against fake UPnP router',
  () => {
    let router: FakeUpnpRouter
    let settingsPath: string
    let settingsManager: SettingsManager
    let eventBus: EventBus
    let natStack: ReturnType<typeof createNatManager>

    beforeAll(async () => {
      router = await startFakeUpnpRouter()

      settingsPath = path.join(
        os.tmpdir(),
        `motrix-nat-e2e-${process.pid}.json`
      )
      eventBus = new EventBus()
      settingsManager = new SettingsManager(settingsPath, { eventBus })
      await settingsManager.load()

      natStack = createNatManager({ eventBus, settingsManager })
    }, 30_000)

    afterAll(async () => {
      await natStack.manager.stop()
      await router.close()
      await fs.rm(settingsPath, { force: true })
    })

    it('discovers, maps, and receives SOAP AddPortMapping', async () => {
      await natStack.manager.start()
      await natStack.manager.mapConfiguredPorts()

      // Allow async work to settle
      await new Promise((r) => setTimeout(r, 500))

      expect(router.soapCalls.length).toBeGreaterThanOrEqual(1)
      expect(router.soapCalls.join('\n')).toContain('AddPortMapping')
    }, 15_000)
  }
)
