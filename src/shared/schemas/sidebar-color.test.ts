import { expect, it } from 'vitest'
import { appSettingsInputSchema, appSettingsSchema } from './app-settings'
import { sidebarColorSchema } from './sidebar-color'

it('preserves existing gray and recovers invalid persisted colors while rejecting invalid edits', () => {
  expect(appSettingsSchema.parse({}).sidebarColor).toBe('gray')
  expect(
    appSettingsSchema.parse({ sidebarColor: 'unknown' }).sidebarColor
  ).toBe('gray')
  for (const sidebarColor of sidebarColorSchema.options) {
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
