// @vitest-environment node

import type { OperationPrincipal } from '@core/plugin/operations/operation-service'
import { Commands } from '@shared/protocol/commands'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'

describe('operation RPC principal', () => {
  it('binds ownership to verified auth and revokes it at logout', async () => {
    let principal: OperationPrincipal | undefined
    let value: unknown
    const app = await createApp({
      operatorAuth: { operatorToken: 'operation-test-token' },
      commandHandlers: {
        [Commands.StartPluginOperation]: async (
          owner: OperationPrincipal,
          payload: unknown
        ) => {
          principal = owner
          value = payload
          return { ok: true }
        },
      },
    })
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/rpc/auth/login',
        payload: { token: 'operation-test-token' },
      })
      const cookie = login.headers['set-cookie']
        ?.toString()
        .split(';')[0] as string
      const url = `/rpc/command/${Commands.StartPluginOperation}`
      expect(
        (await app.inject({ method: 'POST', url, payload: { args: [{}] } }))
          .statusCode
      ).toBe(401)
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie },
            payload: { args: [{ id: 'forged-owner' }, 'extra-owner'] },
          })
        ).statusCode
      ).toBe(200)
      expect(principal?.id).toMatch(/^session:[a-f0-9]{64}$/)
      expect(principal?.eligible()).toBe(true)
      expect(value).toEqual({ id: 'forged-owner' })
      await app.inject({
        method: 'POST',
        url: '/rpc/auth/logout',
        headers: { cookie },
      })
      expect(principal?.eligible()).toBe(false)
    } finally {
      await app.close()
    }
  })
})
