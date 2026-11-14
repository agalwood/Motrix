import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { BDictionary, decode, encode, parseTorrent } from '@motrix/torrent'

/** Independent BEP52 peer with real Merkle proofs and an explicit proof gate. */
export async function startV2MetadataPeer(options: {
  pieceLength: number
  pieces: number
  proofs?: boolean
  corruptProofs?: boolean
  hybrid?: boolean
  private?: boolean
}) {
  const payload = Buffer.alloc(options.pieceLength * options.pieces, 37)
  const sha256 = (data: Uint8Array) =>
    createHash('sha256').update(data).digest()
  const leaves = Array.from(
    { length: Math.ceil(payload.length / 16384) },
    (_, i) => sha256(payload.subarray(i * 16384, (i + 1) * 16384))
  )
  while (leaves.length < 2 ** Math.ceil(Math.log2(leaves.length)))
    leaves.push(Buffer.alloc(32))
  const layers: Buffer[][] = [leaves]
  while (layers[layers.length - 1].length > 1) {
    const previous = layers[layers.length - 1]
    layers.push(
      Array.from({ length: previous.length / 2 }, (_, i) =>
        sha256(Buffer.concat([previous[2 * i], previous[2 * i + 1]]))
      )
    )
  }
  const root = layers[layers.length - 1][0]
  const info = Buffer.from(
    encode({
      name: 'payload.bin',
      'meta version': 2,
      'piece length': options.pieceLength,
      'file tree': {
        'payload.bin': { '': { length: payload.length, 'pieces root': root } },
      },
      ...(options.private ? { private: 1 } : {}),
      ...(options.hybrid
        ? {
            length: payload.length,
            pieces: Buffer.concat(
              Array.from({ length: options.pieces }, (_, index) =>
                createHash('sha1')
                  .update(
                    payload.subarray(
                      index * options.pieceLength,
                      (index + 1) * options.pieceLength
                    )
                  )
                  .digest()
              )
            ),
          }
        : {}),
    })
  )
  const v2 = sha256(info),
    v1 = createHash('sha1').update(info).digest()
  const pieceBase = Math.log2(options.pieceLength / 16384)
  const fullTorrent = Buffer.from(
    encode({
      info: decode(info).value,
      'piece layers': new Map([
        [root, Buffer.concat(layers[pieceBase].slice(0, options.pieces))],
      ]),
    })
  )
  // Independent parser validation protects the fixture, including its layer root.
  parseTorrent(fullTorrent)
  const sockets = new Set<Socket>()
  const hashRequests: Array<{
    base: number
    index: number
    length: number
    proof: number
  }> = []
  const payloadRequests: number[] = []
  let metadataRequests = 0
  let proofs = options.proofs ?? true
  const pending: Array<() => void> = []
  const peerId = Buffer.concat([Buffer.from('-V20001-'), randomBytes(12)])
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let input = Buffer.alloc(0),
      handshaken = false,
      metadataId = 2
    const send = (message: Uint8Array) => {
      if (socket.destroyed) return
      const header = Buffer.alloc(4)
      header.writeUInt32BE(message.length)
      socket.write(Buffer.concat([header, message]))
    }
    socket.on('data', (chunk) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ])
      if (!handshaken) {
        if (input.length < 68) return
        const hash = input.subarray(28, 48)
        if (
          !hash.equals(v2.subarray(0, 20)) &&
          !(options.hybrid && hash.equals(v1))
        )
          return socket.destroy()
        const reply = Buffer.alloc(68)
        reply[0] = 19
        reply.write('BitTorrent protocol', 1)
        reply[25] = 0x10
        reply[27] = 0x10
        reply.set(hash, 28)
        reply.set(peerId, 48)
        socket.write(reply)
        input = input.subarray(68)
        handshaken = true
        send(
          Buffer.concat([
            Buffer.from([20, 0]),
            encode({ m: { ut_metadata: 7 }, metadata_size: info.length }),
          ])
        )
        const bits = Buffer.alloc(Math.ceil(options.pieces / 8))
        for (let i = 0; i < options.pieces; i++) bits[i >> 3] |= 0x80 >> (i % 8)
        send(Buffer.concat([Buffer.from([5]), bits]))
        send(Buffer.from([1]))
      }
      while (input.length >= 4) {
        const size = input.readUInt32BE()
        if (size > 1024 * 1024) return socket.destroy()
        if (input.length < size + 4) return
        const message = input.subarray(4, size + 4)
        input = input.subarray(size + 4)
        if (message[0] === 20) {
          const value = decode(message.subarray(2)).value
          if (!(value instanceof BDictionary)) continue
          if (message[1] === 0) {
            const mapping = value.get('m')
            if (mapping instanceof BDictionary)
              metadataId = Number(mapping.get('ut_metadata') ?? 2)
          } else if (message[1] === 7 && value.get('msg_type') === 0n) {
            metadataRequests++
            const piece = Number(value.get('piece'))
            send(
              Buffer.concat([
                Buffer.from([20, metadataId]),
                encode({ msg_type: 1, piece, total_size: info.length }),
                info.subarray(piece * 16384, (piece + 1) * 16384),
              ])
            )
          }
        } else if (message[0] === 21 && message.length === 49) {
          const base = message.readUInt32BE(33),
            index = message.readUInt32BE(37),
            length = message.readUInt32BE(41),
            proof = message.readUInt32BE(45)
          hashRequests.push({ base, index, length, proof })
          const respond = () => {
            const layer = layers[base]
            if (
              !message.subarray(1, 33).equals(root) ||
              !layer ||
              length < 2 ||
              length & (length - 1) ||
              index % length ||
              index + length > layer.length
            ) {
              send(Buffer.concat([Buffer.from([23]), message.subarray(1)]))
              return
            }
            const hashes = layer
              .slice(index, index + length)
              .map((hash) => Buffer.from(hash))
            let node = index / length
            const extra = Math.max(0, proof - (Math.log2(length) - 1))
            for (
              let level = base + Math.log2(length), count = 0;
              count < extra;
              level++, count++
            ) {
              const sibling = layers[level]?.[node ^ 1]
              if (!sibling) {
                send(Buffer.concat([Buffer.from([23]), message.subarray(1)]))
                return
              }
              hashes.push(Buffer.from(sibling))
              node = Math.floor(node / 2)
            }
            if (options.corruptProofs) hashes[hashes.length - 1][0] ^= 1
            send(
              Buffer.concat([Buffer.from([22]), message.subarray(1), ...hashes])
            )
          }
          if (proofs) respond()
          else pending.push(respond)
        } else if (message[0] === 6 && message.length === 13) {
          const piece = message.readUInt32BE(1),
            begin = message.readUInt32BE(5),
            size = message.readUInt32BE(9)
          payloadRequests.push(piece)
          const block = payload.subarray(
            piece * options.pieceLength + begin,
            piece * options.pieceLength + begin + size
          )
          if (block.length !== size || size > 16384) return socket.destroy()
          send(Buffer.concat([Buffer.from([7]), message.subarray(1, 9), block]))
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing peer port')
  return {
    port: address.port,
    info,
    fullTorrent,
    payload,
    hashRequests,
    payloadRequests,
    requests: () => metadataRequests,
    infoHash: options.hybrid ? v1.toString('hex') : v2.toString('hex'),
    magnet: `magnet:?xt=urn:btmh:1220${v2.toString('hex')}${options.hybrid ? `&xt=urn:btih:${v1.toString('hex')}` : ''}`,
    enableProofs() {
      proofs = true
      for (const send of pending.splice(0)) send()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
