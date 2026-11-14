import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  type NetworkFingerprintSource,
  readNetworkFingerprint,
} from './network-fingerprint'

function fixture(platform = 'darwin') {
  const files = new Map<string, string>()
  const commands = new Map<string, string>()
  let stamp = 'hosts-before'
  const deps: NetworkFingerprintSource = {
    platform,
    systemRoot: 'C:\\Windows',
    interfaces: () => ({
      en0: [
        {
          address: '192.0.2.10',
          family: 'IPv4',
          netmask: '255.255.255.0',
          internal: false,
          mac: '00:00:00:00:00:00',
          cidr: '192.0.2.10/24',
        },
      ],
    }),
    readText: vi.fn(async (file) => {
      const value = files.get(file)
      if (value === undefined) throw new Error('unavailable')
      return value
    }),
    fileStamp: vi.fn(async () => stamp),
    command: vi.fn(async (file, args) => {
      const value = commands.get(`${file} ${args.join(' ')}`)
      if (value === undefined) throw new Error('unavailable private.corp')
      return value
    }),
  }
  return {
    deps,
    files,
    commands,
    setStamp: (value: string) => {
      stamp = value
    },
    read: () => readNetworkFingerprint(new AbortController().signal, deps),
  }
}

describe('network configuration fingerprints', () => {
  it('observes macOS scoped DNS changes without an interface address change', async () => {
    const f = fixture()
    f.commands.set(
      '/usr/sbin/scutil --dns',
      'resolver #1\n domain: private.corp\n nameserver: 192.0.2.53'
    )
    f.commands.set('/usr/sbin/scutil --nwi', 'en0 reachable')
    const before = await f.read()
    expect(await f.read()).toEqual(before)
    f.commands.set(
      '/usr/sbin/scutil --dns',
      'resolver #1\n domain: private.corp\n nameserver: 198.51.100.53'
    )
    const after = await f.read()
    expect(after.key).not.toBe(before.key)
    expect(JSON.stringify(after)).not.toContain('private.corp')
    expect(JSON.stringify(after)).not.toContain('198.51.100.53')
  })

  it('observes Windows NRPT rules independently of adapter IP/DNS addresses', async () => {
    const f = fixture('win32')
    f.commands.set(
      'C:\\Windows\\System32\\ipconfig.exe /all',
      'same adapter and DNS'
    )
    const key =
      'C:\\Windows\\System32\\reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters\\DnsPolicyConfig /s'
    const before = await f.read()
    f.commands.set(key, 'private.corp -> 198.51.100.53')
    expect((await f.read()).key).not.toBe(before.key)
    const configured = await f.read()
    f.commands.delete(key)
    expect((await f.read()).key).toBe(before.key)
    expect(configured.unavailable).not.toContain('nrpt-local')
  })

  it('keeps Linux traffic counters and resolved server selection out of configuration identity', async () => {
    const f = fixture('linux')
    f.files.set('/etc/resolv.conf', 'nameserver 127.0.0.53')
    f.files.set(
      '/proc/net/route',
      'Iface Destination Gateway Flags RefCnt Use Metric Mask\nen0 00000000 010200C0 0003 0 0 100 00000000'
    )
    f.files.set(
      '/proc/net/ipv6_route',
      '0000 00 0000 00 0000 00000001 00000001 00000000 00000001 en0'
    )
    f.commands.set(
      '/usr/bin/resolvectl --no-pager status',
      'DNS Servers: 192.0.2.53 198.51.100.53\nCurrent DNS Server: 192.0.2.53\nDNS Domain: ~corp\nProtocols: DNSSEC=no/unsupported'
    )
    const before = await f.read()
    f.files.set(
      '/proc/net/route',
      'Iface Destination Gateway Flags RefCnt Use Metric Mask\nen0 00000000 010200C0 0003 5 900 100 00000000'
    )
    f.files.set(
      '/proc/net/ipv6_route',
      '0000 00 0000 00 0000 00000001 00000009 00009999 00000001 en0'
    )
    f.commands.set(
      '/usr/bin/resolvectl --no-pager status',
      'DNS Servers: 192.0.2.53 198.51.100.53\nCurrent DNS Server: 198.51.100.53\nDNS Domain: ~corp\nProtocols: DNSSEC=no/supported'
    )
    expect(await f.read()).toEqual(before)
    f.commands.set(
      '/usr/bin/resolvectl --no-pager status',
      'DNS Servers: 192.0.2.53 198.51.100.53\nDNS Domain: ~new-corp\nProtocols: DNSSEC=no/supported'
    )
    expect((await f.read()).key).not.toBe(before.key)
  })

  it('still tracks resolver files and hosts when system tools are unavailable', async () => {
    const f = fixture('linux')
    f.files.set('/etc/resolv.conf', 'nameserver 192.0.2.53')
    const before = await f.read()
    expect(before.unavailable).toContain('resolved')
    expect(await f.read()).toEqual(before)
    f.files.set('/etc/resolv.conf', 'nameserver 198.51.100.53')
    expect((await f.read()).key).not.toBe(before.key)
    f.files.set('/etc/resolv.conf', 'nameserver 192.0.2.53')
    f.setStamp('hosts-after')
    expect((await f.read()).key).not.toBe(before.key)
  })

  it('normalizes interface ordering but notices IPv6 scope changes', async () => {
    const f = fixture()
    const v4 = f.deps.interfaces().en0![0]
    const v6 = {
      ...v4,
      family: 'IPv6',
      address: 'fe80::1',
      scopeid: 3,
    } as NetworkInterfaceInfo
    f.deps.interfaces = () => ({ en0: [v4, v6] })
    const before = await f.read()
    f.deps.interfaces = () => ({ en0: [v6, v4] })
    expect(await f.read()).toEqual(before)
    f.deps.interfaces = () => ({
      en0: [{ ...v6, scopeid: 4 } as NetworkInterfaceInfo, v4],
    })
    expect((await f.read()).key).not.toBe(before.key)
  })

  it('does not publish a cancelled configuration read', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      readNetworkFingerprint(controller.signal, f.deps)
    ).rejects.toThrow()
    expect(f.deps.command).not.toHaveBeenCalled()
  })
})
