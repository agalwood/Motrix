import { describe, expect, it } from 'vitest'
import {
  parsePathTooLong,
  parsePluginChainAbort,
  taskCreateFailureReason,
} from './task-create-failure'

describe('taskCreateFailureReason', () => {
  it('strips the Electron remote-method wrapper and the AppError prefix', () => {
    const error = new Error(
      "Error invoking remote method 'command:createTask': AppError: boom"
    )
    expect(taskCreateFailureReason(error)).toBe('boom')
  })

  it('returns null for a non-Error and for an empty message', () => {
    expect(taskCreateFailureReason('nope')).toBeNull()
    expect(taskCreateFailureReason(new Error('   '))).toBeNull()
  })
})

describe('parsePluginChainAbort', () => {
  it('splits the plugin id from the detail', () => {
    expect(
      parsePluginChainAbort(
        'plugin chain aborted: motrix.scraper-hook: plugin hook timed out after 10000ms'
      )
    ).toEqual({
      pluginId: 'motrix.scraper-hook',
      detail: 'plugin hook timed out after 10000ms',
    })
  })

  it('keeps colons inside the detail intact', () => {
    expect(
      parsePluginChainAbort('plugin chain aborted: some.plugin: a: b: c')
    ).toEqual({ pluginId: 'some.plugin', detail: 'a: b: c' })
  })

  it('returns null when the chain aborted without a plugin attribution', () => {
    expect(parsePluginChainAbort('plugin chain aborted: no-colon-detail')).toBe(
      null
    )
  })

  it('returns null for unrelated failures', () => {
    expect(parsePluginChainAbort('disk is full')).toBeNull()
  })
})

describe('parsePathTooLong', () => {
  it('reads the length, the limit and the offending path', () => {
    expect(
      parsePathTooLong(
        'task path too long: 262/259: F:\\Game\\Dead Cells (2018).motrix\\x.flac'
      )
    ).toEqual({
      length: '262',
      limit: '259',
      path: 'F:\\Game\\Dead Cells (2018).motrix\\x.flac',
    })
  })

  it('keeps colons inside a Windows drive path', () => {
    expect(
      parsePathTooLong('task path too long: 300/259: C:\\a\\b')?.path
    ).toBe('C:\\a\\b')
  })

  it('returns null for unrelated failures', () => {
    expect(parsePathTooLong('disk is full')).toBeNull()
    expect(parsePathTooLong('task path too long: nonsense')).toBeNull()
  })
})
