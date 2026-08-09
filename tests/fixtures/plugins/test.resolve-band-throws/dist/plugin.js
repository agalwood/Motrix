import { hooks } from 'motrix:plugin-api'

hooks.beforeCreate(async () => {
  throw new Error('resolve boom')
})
