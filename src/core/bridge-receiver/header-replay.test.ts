import { describe, expect, it } from 'vitest'
import { stripHopByHopHeaders } from './header-replay'

describe('stripHopByHopHeaders', () => {
  it('removes Cookie, Host, Content-Length, Connection, Transfer-Encoding, Upgrade, Keep-Alive, Proxy-*, TE, Trailer', () => {
    const input = {
      Cookie: 'a=1',
      Host: 'h',
      'Content-Length': '0',
      Connection: 'close',
      'Transfer-Encoding': 'chunked',
      Upgrade: 'websocket',
      'Keep-Alive': '1',
      'Proxy-Authenticate': 'x',
      'Proxy-Authorization': 'y',
      TE: 'trailers',
      Trailer: 'z',
      Authorization: 'Bearer t',
      'X-Custom': 'v',
    }
    const out = stripHopByHopHeaders(input)
    expect(out).toEqual({ Authorization: 'Bearer t', 'X-Custom': 'v' })
  })

  it('is case-insensitive', () => {
    const out = stripHopByHopHeaders({ cookie: 'a=1', COOKIE: 'b=2' })
    expect(out).toEqual({})
  })
})
