import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { BDictionary, decode, encode } from '@motrix/torrent'

export async function startMetadataPeer(info: Buffer) {
  const hash = createHash('sha1').update(info).digest()
  const sockets = new Set<Socket>()
  let requests = 0
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
        handshaken = true
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE()
        if (length > 1024 * 1024) return socket.destroy()
        if (buffer.length < 4 + length) return
        const message = buffer.subarray(4, 4 + length)
        buffer = buffer.subarray(4 + length)
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
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
