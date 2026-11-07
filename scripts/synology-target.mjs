import lock from './synology-runtime.lock.json' with { type: 'json' }

export function synologyTarget(arch) {
  if (!Object.hasOwn(lock.targets, arch))
    throw new Error('Unsupported DSM architecture')
  const target = lock.targets[arch]
  return {
    ...target,
    infoArch: target.infoArch ?? Object.keys(target.platforms).join(' '),
    toolchainDigests: Object.fromEntries(
      Object.entries(target.platforms).map(([platform, sdk]) => [
        platform,
        sdk.toolchain.sha256,
      ])
    ),
  }
}
