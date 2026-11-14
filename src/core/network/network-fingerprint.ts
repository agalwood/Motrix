import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'

const MAX_CONFIG_BYTES = 256 * 1024

export interface NetworkFingerprint {
  key: string
  unavailable: string[]
}

export interface NetworkFingerprintSource {
  platform: string
  systemRoot: string
  interfaces: typeof networkInterfaces
  readText(file: string, signal: AbortSignal): Promise<string>
  fileStamp(file: string): Promise<string>
  command(file: string, args: string[], signal: AbortSignal): Promise<string>
}

const source: NetworkFingerprintSource = {
  platform: process.platform,
  systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  interfaces: networkInterfaces,
  async readText(file, signal) {
    signal.throwIfAborted()
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
      let size = 0
      while (size < buffer.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(
          buffer,
          size,
          buffer.length - size
        )
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > MAX_CONFIG_BYTES) throw new Error('configuration too large')
      return buffer.subarray(0, size).toString('utf8')
    } finally {
      await handle.close()
    }
  },
  async fileStamp(file) {
    const [target, info] = await Promise.all([
      realpath(file),
      stat(file, { bigint: true }),
    ])
    return [
      target,
      info.dev,
      info.ino,
      info.size,
      info.mtimeNs,
      info.ctimeNs,
    ].join(':')
  },
  command(file, args, signal) {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          encoding: 'buffer',
          timeout: 2000,
          maxBuffer: MAX_CONFIG_BYTES,
          windowsHide: true,
          signal,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
        (error, stdout) => {
          // Never propagate stdout/stderr: they contain private DNS domains.
          if (error) reject(new Error('network configuration unavailable'))
          // Windows tools can use an OEM code page. Hash their raw bytes so
          // different non-ASCII NRPT names cannot collapse to replacement text.
          else if (process.platform === 'win32')
            resolve(createHash('sha256').update(stdout).digest('hex'))
          else resolve(stdout.toString('utf8').replaceAll('\r\n', '\n').trim())
        }
      )
    })
  },
}

function routes(text: string, ipv6: boolean): string {
  const columns = ipv6 ? [0, 1, 2, 3, 4, 5, 8, 9] : [0, 1, 2, 3, 6, 7]
  return text
    .trim()
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('Iface'))
    .map((line) => {
      const fields = line.trim().split(/\s+/)
      return columns.map((index) => fields[index] ?? '').join(' ')
    })
    .sort()
    .join('\n')
}

/** Read configuration only; resolution continues through the engine's OS API. */
export async function readNetworkFingerprint(
  signal: AbortSignal,
  deps: NetworkFingerprintSource = source
): Promise<NetworkFingerprint> {
  signal.throwIfAborted()
  const unavailable: string[] = []
  let interfaces: string[]
  try {
    interfaces = Object.entries(deps.interfaces())
      .flatMap(([name, addresses]) =>
        (addresses ?? []).map((address) =>
          [
            name,
            address.family,
            address.address,
            address.netmask,
            address.mac,
            address.scopeid ?? 0,
            address.internal,
          ].join(':')
        )
      )
      .sort()
  } catch {
    interfaces = ['unavailable']
    unavailable.push('interfaces')
  }
  const reads: [string, () => Promise<string>][] = []
  const file = (name: string, file: string) =>
    reads.push([name, () => deps.readText(file, signal)])
  const command = (name: string, file: string, args: string[]) =>
    reads.push([name, () => deps.command(file, args, signal)])
  const hosts =
    deps.platform === 'win32'
      ? path.win32.join(deps.systemRoot, 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/hosts'
  reads.push(['hosts', () => deps.fileStamp(hosts)])
  if (deps.platform === 'darwin') {
    command('dns', '/usr/sbin/scutil', ['--dns'])
    command('routes', '/usr/sbin/scutil', ['--nwi'])
  } else if (deps.platform === 'win32') {
    const system = path.win32.join(deps.systemRoot, 'System32')
    command('adapters', path.win32.join(system, 'ipconfig.exe'), ['/all'])
    // Both Group Policy and local/VPN rules can supply NRPT entries.
    for (const [name, key] of [
      [
        'nrpt-policy',
        'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient',
      ],
      [
        'nrpt-local',
        'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters\\DnsPolicyConfig',
      ],
    ])
      command(name, path.win32.join(system, 'reg.exe'), ['query', key, '/s'])
  } else {
    file('resolv', '/etc/resolv.conf')
    file('nss', '/etc/nsswitch.conf')
    reads.push([
      'routes-v4',
      async () => routes(await deps.readText('/proc/net/route', signal), false),
    ])
    reads.push([
      'routes-v6',
      async () =>
        routes(await deps.readText('/proc/net/ipv6_route', signal), true),
    ])
    // A stub resolv.conf does not describe resolved's per-link routing domains.
    // In containers/NAS without resolved, the files above remain observable.
    reads.push([
      'resolved',
      async () =>
        (
          await deps.command(
            '/usr/bin/resolvectl',
            ['--no-pager', 'status'],
            signal
          )
        )
          .split('\n')
          .filter((line) => !line.includes('Current DNS Server:'))
          .map((line) =>
            line.replace(
              /DNSSEC=(yes|no)\/(?:supported|unsupported)/g,
              'DNSSEC=$1'
            )
          )
          .join('\n'),
    ])
  }
  const values = await Promise.all(
    reads.map(async ([name, read]) => {
      try {
        return [name, 'ok', await read()]
      } catch {
        unavailable.push(name)
        return [name, 'unavailable']
      }
    })
  )
  signal.throwIfAborted()
  return {
    key: createHash('sha256')
      .update(JSON.stringify([interfaces, values]))
      .digest('hex'),
    unavailable: unavailable.sort(),
  }
}
