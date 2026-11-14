import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { BDictionary, decode, encode } from '@motrix/torrent'

/** Accept TCP but never answer a BT handshake; distinct ports remain distinct candidates. */
export async function startSilentMetadataPeers(count: number) {
  const servers: Server[] = []
  const sockets = new Set<Socket>()
  const ports: number[] = []
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
    )
  }
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        socket.resume()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a peer port')
      ports.push(address.port)
    }
    return { ports, close }
  } catch (error) {
    await close()
    throw error
  }
}

export async function startMetadataPeer(info: Buffer, payload?: Buffer) {
  const hash = createHash('sha1').update(info).digest()
  const sockets = new Set<Socket>()
  let requests = 0
  const payloadRequests: number[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let handshaken = false
    let remoteMetadataId = 2
    const send = (id: number, payload: Uint8Array) => {
      const frame = Buffer.alloc(6 + payload.length)
      frame.writeUInt32BE(2 + payload.length)
      frame[4] = 20
      frame[5] = id
      frame.set(payload, 6)
      socket.write(frame)
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([
        buffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ])
      if (!handshaken) {
        if (buffer.length < 68) return
        if (!buffer.subarray(28, 48).equals(hash)) return socket.destroy()
        buffer = buffer.subarray(68)
        const response = Buffer.alloc(68)
        response[0] = 19
        response.write('BitTorrent protocol', 1)
        response[25] = 0x10
        response.set(hash, 28)
        response.write('-MF0001-METADATA0001', 48)
        socket.write(response)
        // Deliberately use a different extension ID from taiji's local ID.
        send(0, encode({ m: { ut_metadata: 7 }, metadata_size: info.length }))
        if (payload) {
          // Test payloads use 16 KiB pieces. Advertise and unchoke only when
          // explicitly serving data; discovery tests remain metadata-only.
          const count = Math.ceil(payload.length / 16384)
          const bits = Buffer.alloc(Math.ceil(count / 8))
          for (let index = 0; index < count; index++)
            bits[index >> 3] |= 0x80 >> (index % 8)
          const frame = Buffer.alloc(5 + bits.length)
          frame.writeUInt32BE(1 + bits.length)
          frame[4] = 5
          frame.set(bits, 5)
          socket.write(frame)
          socket.write(Buffer.from([0, 0, 0, 1, 1]))
        }
        handshaken = true
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE()
        if (length > 1024 * 1024) return socket.destroy()
        if (buffer.length < 4 + length) return
        const message = buffer.subarray(4, 4 + length)
        buffer = buffer.subarray(4 + length)
        if (payload && message[0] === 6 && message.length === 13) {
          const piece = message.readUInt32BE(1),
            begin = message.readUInt32BE(5),
            size = message.readUInt32BE(9)
          if (size > 16384 || begin + size > 16384) return socket.destroy()
          const block = payload.subarray(
            piece * 16384 + begin,
            piece * 16384 + begin + size
          )
          if (block.length !== size) return socket.destroy()
          payloadRequests.push(piece)
          const frame = Buffer.alloc(13 + size)
          frame.writeUInt32BE(9 + size)
          frame[4] = 7
          frame.writeUInt32BE(piece, 5)
          frame.writeUInt32BE(begin, 9)
          frame.set(block, 13)
          socket.write(frame)
          continue
        }
        if (message[0] !== 20 || length < 2) continue
        const value = decode(message.subarray(2)).value
        if (!(value instanceof BDictionary)) continue
        if (message[1] === 0) {
          const mapping = value.get('m')
          if (mapping instanceof BDictionary)
            remoteMetadataId = Number(mapping.get('ut_metadata') ?? 2)
        } else if (message[1] === 7 && value.get('msg_type') === 0n) {
          const piece = Number(value.get('piece'))
          requests++
          send(
            remoteMetadataId,
            Buffer.concat([
              encode({ msg_type: 1, piece, total_size: info.length }),
              info.subarray(piece * 16384, (piece + 1) * 16384),
            ])
          )
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing peer')
  return {
    port: address.port,
    hash: hash.toString('hex'),
    requests: () => requests,
    payloadRequests: () => [...payloadRequests],
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
