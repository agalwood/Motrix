#!/usr/bin/env node
// Time-bounded fuzzing runner for NAT codecs.
// Usage: node --import tsx scripts/fuzz-nat-codecs.mjs [--duration=SEC] [--codec=NAME]
// Exits non-zero if any codec throws on any input.

import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'

const DURATION_SEC = Number(
  (process.argv.find((a) => a.startsWith('--duration=')) ?? '=30').split('=')[1]
)
const CODEC_FILTER = (
  process.argv.find((a) => a.startsWith('--codec=')) ?? '='
).split('=')[1]

async function loadCodecs() {
  const mod = await import('../src/core/nat/codecs/index.ts')
  return mod
}

async function main() {
  const codecs = await loadCodecs()
  const gatewayIp = '192.168.1.1'

  const targets = [
    {
      name: 'parseMSearchResponse',
      run: () => {
        const len = crypto.randomInt(0, 4096)
        codecs.parseMSearchResponse(crypto.randomBytes(len))
      },
    },
    {
      name: 'parseXml',
      run: () => {
        const len = crypto.randomInt(0, 4096)
        codecs.parseXml(crypto.randomBytes(len).toString('utf-8'))
      },
    },
    {
      name: 'parseSoapResponse',
      run: () => {
        const len = crypto.randomInt(0, 16 * 1024)
        codecs.parseSoapResponse(crypto.randomBytes(len).toString('utf-8'))
      },
    },
    {
      name: 'parseDeviceDescription',
      run: () => {
        const len = crypto.randomInt(0, 64 * 1024)
        codecs.parseDeviceDescription(crypto.randomBytes(len).toString('utf-8'))
      },
    },
    {
      name: 'parseNatPmpResponse',
      run: () => {
        const len = crypto.randomInt(0, 64)
        codecs.parseNatPmpResponse(
          crypto.randomBytes(len),
          crypto.randomInt(0, 3),
          gatewayIp,
          gatewayIp
        )
      },
    },
    {
      name: 'parsePcpMapResponse',
      run: () => {
        const len = crypto.randomInt(0, 128)
        codecs.parsePcpMapResponse(
          crypto.randomBytes(len),
          crypto.randomBytes(12),
          gatewayIp,
          gatewayIp
        )
      },
    },
    {
      name: 'parseBindingResponse',
      run: () => {
        const len = crypto.randomInt(0, 576)
        codecs.parseBindingResponse(
          crypto.randomBytes(len),
          crypto.randomBytes(12)
        )
      },
    },
  ].filter((t) => !CODEC_FILTER || t.name.includes(CODEC_FILTER))

  for (const t of targets) {
    const start = performance.now()
    let iters = 0
    let crashed = false
    const endTime = start + DURATION_SEC * 1000
    while (performance.now() < endTime) {
      try {
        t.run()
      } catch (err) {
        console.error(`${t.name} CRASHED at iter ${iters}: ${err.message}`)
        crashed = true
        break
      }
      iters++
    }
    const elapsed = (performance.now() - start) / 1000
    const rate = Math.round(iters / elapsed)
    console.log(
      `${t.name}: ${iters} iters in ${elapsed.toFixed(1)}s (${rate}/sec)${crashed ? ' — FAILED' : ' — OK'}`
    )
    if (crashed) process.exit(1)
  }
  console.log('All fuzz targets completed without crashes.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
