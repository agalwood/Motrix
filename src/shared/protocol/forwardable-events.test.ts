import { describe, expect, it } from 'vitest'
import { BridgeEvents } from './bridge'
import { Events } from './events'
import { ForwardableEvents } from './forwardable-events'

describe('ForwardableEvents', () => {
  it('contains TaskUpdated', () => {
    expect(ForwardableEvents).toContain(Events.TaskUpdated)
  })

  it('contains every engine/plugin/nat/tracker/update event', () => {
    expect(ForwardableEvents).toContain(Events.EngineStateChanged)
    expect(ForwardableEvents).toContain(Events.NatStateChanged)
    expect(ForwardableEvents).toContain(Events.TrackerListUpdated)
    expect(ForwardableEvents).toContain(Events.UpdateAvailable)
  })

  it('has 50 total forwardable events', () => {
    expect(ForwardableEvents).toHaveLength(50)
  })

  it('includes the bridge approval events (web-shell pairing)', () => {
    expect(ForwardableEvents).toContain(BridgeEvents.PairRequested)
    expect(ForwardableEvents).toContain(BridgeEvents.Paired)
    expect(ForwardableEvents).toContain(BridgeEvents.Revoked)
    expect(ForwardableEvents).toContain(BridgeEvents.Error)
  })

  it('includes the pair request lifecycle events (pending -> settled | expired)', () => {
    expect(ForwardableEvents).toContain(BridgeEvents.PairRequestSettled)
    expect(ForwardableEvents).toContain(BridgeEvents.PairRequestExpired)
  })

  it('includes all task events', () => {
    expect(ForwardableEvents).toContain(Events.TaskUpdated)
    expect(ForwardableEvents).toContain(Events.TaskFilesUpdated)
    expect(ForwardableEvents).toContain(Events.TaskActivityUpdated)
    expect(ForwardableEvents).toContain(Events.TaskInspectorActivityUpdated)
    expect(ForwardableEvents).toContain(Events.StatsUpdated)
    expect(ForwardableEvents).toContain(Events.MagnetFileSelection)
  })

  it('includes all engine events', () => {
    expect(ForwardableEvents).toContain(Events.EngineDisconnected)
    expect(ForwardableEvents).toContain(Events.EngineRecovered)
    expect(ForwardableEvents).toContain(Events.EngineReconnecting)
    expect(ForwardableEvents).toContain(Events.EngineStateChanged)
    expect(ForwardableEvents).toContain(Events.EngineActiveChanged)
    expect(ForwardableEvents).toContain(Events.EngineRestartRequired)
    expect(ForwardableEvents).toContain(Events.PortConflict)
  })

  it('includes all plugin events', () => {
    expect(ForwardableEvents).toContain(Events.PluginError)
    expect(ForwardableEvents).toContain(Events.PluginTimeout)
    expect(ForwardableEvents).toContain(Events.PluginStatusChanged)
    expect(ForwardableEvents).toContain(Events.PluginConfigChanged)
    expect(ForwardableEvents).toContain(Events.PluginGrantsChanged)
    expect(ForwardableEvents).toContain(Events.PluginEvicted)
    expect(ForwardableEvents).toContain(Events.PluginActivationCapExceeded)
  })

  it('includes locale changes for every renderer window', () => {
    expect(ForwardableEvents).toContain(Events.LocaleChanged)
  })

  it('includes all NAT events', () => {
    expect(ForwardableEvents).toContain(Events.NatStateChanged)
    expect(ForwardableEvents).toContain(Events.NatMappingUpdated)
    expect(ForwardableEvents).toContain(Events.NatDiagnosticCompleted)
    expect(ForwardableEvents).toContain(Events.NatGatewayChanged)
    expect(ForwardableEvents).toContain(Events.NatError)
  })

  it('includes tuning events', () => {
    expect(ForwardableEvents).toContain(Events.TuningUpdated)
  })

  it('includes speed-limit events', () => {
    expect(ForwardableEvents).toContain(Events.SpeedLimitChanged)
  })

  it('includes GeoIP progress and status events', () => {
    expect(ForwardableEvents).toContain(Events.GeoIPUpdateProgress)
    expect(ForwardableEvents).toContain(Events.GeoIPStatusChanged)
  })

  it('includes all tracker events', () => {
    expect(ForwardableEvents).toContain(Events.TrackerListUpdated)
    expect(ForwardableEvents).toContain(Events.TrackerSyncFailed)
  })

  it('includes all auto-update events', () => {
    expect(ForwardableEvents).toContain(Events.UpdateStateChanged)
    expect(ForwardableEvents).toContain(Events.UpdateCheckStarted)
    expect(ForwardableEvents).toContain(Events.UpdateAvailable)
    expect(ForwardableEvents).toContain(Events.UpdateNotAvailable)
    expect(ForwardableEvents).toContain(Events.UpdateDownloadProgress)
    expect(ForwardableEvents).toContain(Events.UpdateDownloaded)
    expect(ForwardableEvents).toContain(Events.UpdateCancelled)
    expect(ForwardableEvents).toContain(Events.UpdateError)
  })

  it('includes the notification events', () => {
    expect(ForwardableEvents).toContain(Events.NotificationAdded)
    expect(ForwardableEvents).toContain(Events.NotificationsChanged)
  })

  it('excludes EngineFailureOccurred (internal main-process producer signal)', () => {
    expect(ForwardableEvents).not.toContain(Events.EngineFailureOccurred)
  })

  it('excludes the Electron-only application-menu mirror event', () => {
    expect(ForwardableEvents).not.toContain(Events.ApplicationMenuChanged)
  })
})
