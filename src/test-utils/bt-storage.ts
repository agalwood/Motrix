import { createHash } from 'node:crypto'

type Encodable =
  | string
  | number
  | Buffer
  | Encodable[]
  | { [key: string]: Encodable }
function encode(value: Encodable): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value))
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(encode),
      Buffer.from('e'),
    ])
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const data = Buffer.from(value)
    return Buffer.concat([Buffer.from(`${data.length}:`), data])
  }
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key])]),
    Buffer.from('e'),
  ])
}

export function storageTorrent(
  files: Array<{ name: string; data: string | Buffer }>,
  multiFile = files.length > 1,
  pieceLength = 4
): Buffer {
  const data = Buffer.concat(files.map((file) => Buffer.from(file.data)))
  const hashes: Buffer[] = []
  for (let offset = 0; offset < data.length; offset += pieceLength)
    hashes.push(
      createHash('sha1')
        .update(data.subarray(offset, offset + pieceLength))
        .digest()
    )
  return encode({
    info: {
      name: multiFile ? 'bundle' : files[0].name,
      'piece length': pieceLength,
      pieces: Buffer.concat(hashes),
      ...(multiFile
        ? {
            files: files.map((file) => ({
              path: file.name.split('/'),
              length: Buffer.byteLength(file.data),
            })),
          }
        : { length: data.length }),
    },
  })
}
