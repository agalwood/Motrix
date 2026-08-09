import { hooks } from 'motrix:plugin-api'

hooks.beforeCreate(async (ctx) => {
  await ctx.update({ uris: ['https://cdn.example.com/resolved'] })
})
