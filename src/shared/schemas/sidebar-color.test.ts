import { expect, it } from 'vitest'
import { appSettingsInputSchema, appSettingsSchema } from './app-settings'
import { sidebarColorSchema } from './sidebar-color'

it('defaults to cyan and recovers invalid persisted colors while preserving saved choices', () => {
  expect(appSettingsSchema.parse({}).sidebarColor).toBe('cyan')
  expect(
    appSettingsSchema.parse({ sidebarColor: 'unknown' }).sidebarColor
  ).toBe('cyan')
  for (const sidebarColor of sidebarColorSchema.options) {
    expect(appSettingsSchema.parse({ sidebarColor }).sidebarColor).toBe(
      sidebarColor
    )
    expect(
      appSettingsInputSchema
        .pick({ sidebarColor: true })
        .parse({ sidebarColor })
    ).toEqual({ sidebarColor })
  }
  expect(
    appSettingsInputSchema
      .pick({ sidebarColor: true })
      .safeParse({ sidebarColor: 'unknown' }).success
  ).toBe(false)
})
