import { hooks } from 'motrix:plugin-api'

hooks.beforeCreate(async (ctx) => {
  await ctx.update({ headers: [{ name: 'X-Enrich-Throws', value: 'leaked' }] })
  throw new Error('enrich boom')
})
