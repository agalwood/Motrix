import { TaskStatus, TransitionPhase } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { shouldSkipEngineCompletionFinalize } from './should-skip-engine-completion-finalize'

describe('shouldSkipEngineCompletionFinalize', () => {
  it('allows the first completion event for an idle temporary output', () => {
    expect(
      shouldSkipEngineCompletionFinalize(
        makeDownloadTask({
          status: TaskStatus.Downloading,
          transitionPhase: TransitionPhase.Idle,
          diskPath: '/downloads/file.motrix',
          finalPath: '/downloads/file',
        })
      )
    ).toBe(false)
  })

  it.each([
    {
      label: 'already renamed output',
      status: TaskStatus.Seeding,
      phase: TransitionPhase.Idle,
      diskPath: '/downloads/file',
    },
    {
      label: 'active finalization',
      status: TaskStatus.Finalizing,
      phase: TransitionPhase.Renaming,
      diskPath: '/downloads/file.motrix',
    },
    {
      label: 'manual-review recovery quarantine',
      status: TaskStatus.Error,
      phase: TransitionPhase.Renaming,
      diskPath: '/downloads/file.motrix',
    },
  ])('skips $label', ({ status, phase, diskPath }) => {
    expect(
      shouldSkipEngineCompletionFinalize(
        makeDownloadTask({
          status,
          transitionPhase: phase,
          diskPath,
          finalPath: '/downloads/file',
        })
      )
    ).toBe(true)
  })

  // An already-terminal, already-renamed task is skipped via diskPath === finalPath.
  it.each([
    { label: 'Completed', status: TaskStatus.Completed },
    { label: 'Error', status: TaskStatus.Error },
  ])(
    'skips an already-renamed poll-already-terminal ($label) task',
    ({ status }) => {
      expect(
        shouldSkipEngineCompletionFinalize(
          makeDownloadTask({
            status,
            transitionPhase: TransitionPhase.Idle,
            diskPath: '/downloads/file',
            finalPath: '/downloads/file',
          })
        )
      ).toBe(true)
    }
  )

  it.each([
    { label: 'Completed', status: TaskStatus.Completed },
    { label: 'Error', status: TaskStatus.Error },
  ])(
    'does not skip an already-terminal but unrenamed ($label) task (self-heal allowed)',
    ({ status }) => {
      expect(
        shouldSkipEngineCompletionFinalize(
          makeDownloadTask({
            status,
            transitionPhase: TransitionPhase.Idle,
            diskPath: '/downloads/file.motrix',
            finalPath: '/downloads/file',
          })
        )
      ).toBe(false)
    }
  )
})
