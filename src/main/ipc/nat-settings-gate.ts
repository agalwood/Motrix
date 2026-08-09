export interface PrivacyGateInput<T> {
  oldSettings: T
  newSettings: T
  dialogConfirm: (opts: {
    title: string
    message: string
    detail: string
  }) => Promise<boolean>
}

interface MinimalSettingsShape {
  nat: {
    natTypeDetectionEnabled: boolean
    portReachabilityCheckEnabled: boolean
  }
}

/**
 * Enforces native-dialog confirmation for privacy-sensitive NAT toggles.
 * Returns the new settings with any unconfirmed toggles reverted to their old value.
 */
export async function applyNatPrivacyGate<T extends MinimalSettingsShape>(
  input: PrivacyGateInput<T>
): Promise<T> {
  const { oldSettings, newSettings, dialogConfirm } = input
  const reverted = JSON.parse(JSON.stringify(newSettings)) as T

  if (
    !oldSettings.nat.natTypeDetectionEnabled &&
    newSettings.nat.natTypeDetectionEnabled
  ) {
    const confirmed = await dialogConfirm({
      title: 'Enable NAT type detection?',
      message: 'NAT type detection uses STUN servers you configure.',
      detail:
        'When enabled, Motrix will contact the STUN servers you have added. ' +
        'Each server will see your public IP address. No servers are pre-configured. ' +
        'You can disable this feature at any time.',
    })
    if (!confirmed) {
      reverted.nat.natTypeDetectionEnabled = false
    }
  }

  if (
    !oldSettings.nat.portReachabilityCheckEnabled &&
    newSettings.nat.portReachabilityCheckEnabled
  ) {
    const confirmed = await dialogConfirm({
      title: 'Enable port reachability check?',
      message: 'Port reachability check contacts external services.',
      detail:
        'When enabled, Motrix will send your public IP and listening port to the ' +
        'HTTPS endpoints you have configured. No endpoints are pre-configured. ' +
        'You can disable this feature at any time.',
    })
    if (!confirmed) {
      reverted.nat.portReachabilityCheckEnabled = false
    }
  }

  return reverted
}
