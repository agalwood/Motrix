import type {
  UdpMessageListener,
  UdpRemoteInfo,
  UdpSocket,
  UdpSocketFactory,
  UdpSocketOptions,
} from './udp-socket'

export interface MockUdpSendCall {
  data: Buffer
  port: number
  address: string
}

export class MockUdpSocket implements UdpSocket {
  // Diagnostic-only field; not part of the UdpSocket interface contract.
  public readonly type: 'udp4' = 'udp4'
  public sendCalls: MockUdpSendCall[] = []
  public boundPort: number | null = null
  public boundAddress: string | null = null
  public memberships: Array<{ multicast: string; iface?: string }> = []
  public ttl: number | null = null
  public closed = false

  private listeners = new Set<UdpMessageListener>()

  async bind(port?: number, address?: string): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.boundPort = port ?? 0
    this.boundAddress = address ?? '0.0.0.0'
  }

  addMembership(multicast: string, iface?: string): void {
    if (this.closed) throw new Error('socket closed')
    this.memberships.push({ multicast, iface })
  }

  setMulticastTTL(ttl: number): void {
    if (this.closed) throw new Error('socket closed')
    this.ttl = ttl
  }

  async send(msg: Buffer, port: number, address: string): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.sendCalls.push({ data: Buffer.from(msg), port, address })
  }

  onMessage(listener: UdpMessageListener): void {
    this.listeners.add(listener)
  }

  offMessage(listener: UdpMessageListener): void {
    this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
    this.listeners.clear()
  }

  address(): { port: number; address: string } | null {
    if (this.boundPort === null) return null
    return { port: this.boundPort, address: this.boundAddress ?? '0.0.0.0' }
  }

  // Test helpers
  emitMessage(data: Buffer, rinfo: UdpRemoteInfo): void {
    for (const l of this.listeners) l(data, rinfo)
  }
}

export function createMockUdpFactory(): {
  factory: UdpSocketFactory
  sockets: MockUdpSocket[]
} {
  const sockets: MockUdpSocket[] = []
  const factory: UdpSocketFactory = (_opts: UdpSocketOptions) => {
    const s = new MockUdpSocket()
    sockets.push(s)
    return s
  }
  return { factory, sockets }
}
