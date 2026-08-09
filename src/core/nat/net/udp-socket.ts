import dgram from 'node:dgram'

export interface UdpSocketOptions {
  type: 'udp4'
  reuseAddr?: boolean
}

export interface UdpRemoteInfo {
  address: string
  port: number
  size: number
}

export type UdpMessageListener = (msg: Buffer, rinfo: UdpRemoteInfo) => void

export interface UdpSocket {
  bind(port?: number, address?: string): Promise<void>
  addMembership(multicastAddress: string, interfaceAddress?: string): void
  setMulticastTTL(ttl: number): void
  send(msg: Buffer, port: number, address: string): Promise<void>
  onMessage(listener: UdpMessageListener): void
  offMessage(listener: UdpMessageListener): void
  close(): Promise<void>
  address(): { port: number; address: string } | null
}

export class NodeUdpSocket implements UdpSocket {
  private socket: dgram.Socket | null
  private listeners = new Set<UdpMessageListener>()
  private closed = false

  constructor(options: UdpSocketOptions) {
    this.socket = dgram.createSocket({
      type: options.type,
      reuseAddr: options.reuseAddr ?? true,
    })
    this.socket.on('message', (msg, rinfo) => {
      for (const l of this.listeners) l(msg, rinfo)
    })
  }

  bind(port?: number, address?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('socket closed'))
      const onErr = (e: Error) => {
        this.socket?.off('error', onErr)
        reject(e)
      }
      this.socket.once('error', onErr)
      this.socket.bind(port ?? 0, address, () => {
        this.socket?.off('error', onErr)
        resolve()
      })
    })
  }

  addMembership(multicastAddress: string, interfaceAddress?: string): void {
    if (!this.socket) throw new Error('socket closed')
    this.socket.addMembership(multicastAddress, interfaceAddress)
  }

  setMulticastTTL(ttl: number): void {
    if (!this.socket) throw new Error('socket closed')
    this.socket.setMulticastTTL(ttl)
  }

  send(msg: Buffer, port: number, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('socket closed'))
      this.socket.send(msg, port, address, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  onMessage(listener: UdpMessageListener): void {
    this.listeners.add(listener)
  }

  offMessage(listener: UdpMessageListener): void {
    this.listeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.closed || !this.socket) return Promise.resolve()
    this.closed = true
    const s = this.socket
    this.socket = null
    return new Promise((resolve) => {
      s.close(() => resolve())
    })
  }

  address(): { port: number; address: string } | null {
    if (!this.socket) return null
    try {
      const a = this.socket.address()
      return { port: a.port, address: a.address }
    } catch {
      return null
    }
  }
}

export type UdpSocketFactory = (options: UdpSocketOptions) => UdpSocket
export const nodeUdpSocketFactory: UdpSocketFactory = (opts) =>
  new NodeUdpSocket(opts)
