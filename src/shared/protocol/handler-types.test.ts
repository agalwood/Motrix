import { describe, expect, it } from 'vitest'
import { Commands } from './commands'
import type {
  CommandHandlerMap,
  CommandInvoker,
  QueryHandlerMap,
  QueryInvoker,
} from './handler-types'
import { Queries } from './queries'

describe('handler-types', () => {
  it('allows a command handler map keyed by Commands channels', () => {
    const map: CommandHandlerMap = {
      [Commands.PauseTask]: async (taskId: string) => ({ ok: true, taskId }),
    }
    expect(typeof map[Commands.PauseTask]).toBe('function')
  })

  it('invokers accept channel + args', async () => {
    const inv: CommandInvoker = async (channel, ...args) => [channel, args]
    expect(await inv(Commands.PauseTask, 't1')).toEqual([
      Commands.PauseTask,
      ['t1'],
    ])
  })

  it('query types compile', () => {
    const map: QueryHandlerMap = {
      [Queries.ListTasks]: async () => [],
    }
    const inv: QueryInvoker = async () => null
    expect(typeof map).toBe('object')
    expect(typeof inv).toBe('function')
  })
})
