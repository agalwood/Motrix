import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { analyzeDownloadSource } from '@shared/lib/download-source'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectResourceValidatorService } from './direct-resource-validator'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'download URL request-target parity',
  () => {
    let dir: string
    let server: Server
    let origin: string
    let engine: Aria2Handle
    let wired: Awaited<ReturnType<typeof connectAdapter>>
    const requests: string[] = []
    let count = 0

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'motrix-url-parity-'))
      server = createServer((req, res) => {
        requests.push(req.url ?? '')
        res.writeHead(200, { 'content-length': '7', etag: '"fixture"' })
        res.end('fixture')
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing test listener')
      origin = `http://127.0.0.1:${address.port}`
      engine = await spawnAria2ForTest({ baseDir: dir })
      wired = await connectAdapter(engine)
    })

    afterAll(async () => {
      wired?.disconnect()
      await engine?.kill()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    it.each([
      [
        '/a//b?x=%2f&x=%2F&empty=&plus=+&space=%20&nested=%252F',
        '/a//b?x=%2f&x=%2F&empty=&plus=+&space=%20&nested=%252F',
      ],
      ['/file?path=one\\two&sig=%5C%25', '/file?path=one\\two&sig=%5C%25'],
      [
        '/文件?键=值&sig=%2f#preview',
        '/%E6%96%87%E4%BB%B6?%E9%94%AE=%E5%80%BC&sig=%2f',
      ],
      [
        '/encoded%2Fslash%5Ctext?x=%00%0D%0A',
        '/encoded%2Fslash%5Ctext?x=%00%0D%0A',
      ],
    ])('delivers identical bytes for %s', async (input, target) => {
      const source = analyzeDownloadSource(origin + input)
      expect(source.status).toBe('accepted')
      if (source.status !== 'accepted') return
      requests.length = 0
      const metadata = await new DirectResourceValidatorService().probe(
        source.requestUrl
      )
      expect(metadata).not.toBeNull()
      expect(requests).toEqual([target])
      requests.length = 0
      const filename = `sample-${count++}.bin`
      const gid = await wired.adapter.createDownload({
        uris: [source.requestUrl],
        saveDir: dir,
        filename,
      })
      await expect
        .poll(async () => (await wired.rpc.tellStatus(gid)).status, {
          timeout: 5000,
        })
        .toBe('complete')
      expect(requests).toEqual([target])
      expect(await readFile(path.join(dir, filename), 'utf8')).toBe('fixture')
    })

    it('downloads FTP through the bundled engine', async () => {
      const sockets = new Set<Socket>()
      let dataSocket: Socket | undefined
      const data = createTcpServer((socket) => {
        dataSocket = socket
        sockets.add(socket)
      })
      await new Promise<void>((resolve) => data.listen(0, '127.0.0.1', resolve))
      const dataAddress = data.address()
      if (!dataAddress || typeof dataAddress === 'string')
        throw new Error('Missing FTP data listener')
      const commands: string[] = []
      const control = createTcpServer((socket) => {
        sockets.add(socket)
        socket.write('220 Test FTP\r\n')
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          for (;;) {
            const end = buffer.indexOf('\r\n')
            if (end < 0) break
            const line = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const command = line.split(' ')[0]
            commands.push(command)
            if (command === 'USER') socket.write('331 Password required\r\n')
            else if (command === 'PASS') socket.write('230 Logged in\r\n')
            else if (command === 'PWD') socket.write('257 "/"\r\n')
            else if (command === 'CWD')
              socket.write('250 Directory changed\r\n')
            else if (command === 'SIZE') socket.write('213 7\r\n')
            else if (command === 'MDTM') socket.write('213 20260916000000\r\n')
            else if (command === 'EPSV')
              socket.write(
                `229 Entering Extended Passive Mode (|||${dataAddress.port}|)\r\n`
              )
            else if (command === 'PASV')
              socket.write(
                `227 Entering Passive Mode (127,0,0,1,${dataAddress.port >> 8},${dataAddress.port & 255})\r\n`
              )
            else if (command === 'RETR') {
              socket.write('150 Opening data connection\r\n')
              dataSocket?.end('fixture', () =>
                socket.write('226 Transfer complete\r\n')
              )
            } else if (command === 'QUIT') socket.end('221 Goodbye\r\n')
            else socket.write('200 OK\r\n')
          }
        })
      })
      await new Promise<void>((resolve) =>
        control.listen(0, '127.0.0.1', resolve)
      )
      try {
        const address = control.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing FTP listener')
        const gid = await wired.adapter.createDownload({
          uris: [`ftp://127.0.0.1:${address.port}/fixture.bin`],
          saveDir: dir,
          filename: 'ftp.bin',
        })
        try {
          await expect
            .poll(async () => (await wired.rpc.tellStatus(gid)).status, {
              timeout: 5000,
            })
            .toBe('complete')
        } catch {
          throw new Error(
            JSON.stringify({
              commands,
              status: await wired.rpc.tellStatus(gid),
            })
          )
        }
        expect(await readFile(path.join(dir, 'ftp.bin'), 'utf8')).toBe(
          'fixture'
        )
        expect(commands).toContain('RETR')
      } finally {
        for (const socket of sockets) socket.destroy()
        await Promise.all([
          new Promise<void>((resolve) => control.close(() => resolve())),
          new Promise<void>((resolve) => data.close(() => resolve())),
        ])
      }
    }, 15000)
  }
)
