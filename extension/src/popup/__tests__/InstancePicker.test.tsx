import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PairCandidate } from '@/background/ConnectionManager'
import { InstancePicker } from '@/popup/InstancePicker'
import { i18n } from '@/shared/i18n'

function candidate(port: number): PairCandidate {
  return { port, instanceId: `instance-${port}`, appVersion: '2.0.0' }
}

function renderPicker(candidates: PairCandidate[]) {
  return render(
    <InstancePicker
      candidates={candidates}
      onChoose={vi.fn()}
      onRescan={vi.fn()}
    />
  )
}

describe('InstancePicker', () => {
  it('shows only the empty state when no candidate is live — never the multiple-instances help', () => {
    renderPicker([])
    expect(screen.getByText(i18n.t('popup.pairing.noCandidates'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('popup.pairing.pickerHelp'))).toBeNull()
  })

  it('lists a single candidate without claiming multiple instances were found', () => {
    renderPicker([candidate(16802)])
    expect(
      screen.getByText(i18n.t('popup.pairing.candidatePort', { port: 16802 }))
    ).toBeTruthy()
    expect(screen.queryByText(i18n.t('popup.pairing.pickerHelp'))).toBeNull()
    expect(screen.queryByText(i18n.t('popup.pairing.noCandidates'))).toBeNull()
  })

  it('shows the multiple-instances help once several candidates are live', () => {
    renderPicker([candidate(16802), candidate(16803)])
    expect(screen.getByText(i18n.t('popup.pairing.pickerHelp'))).toBeTruthy()
  })

  it('keeps the rescan button available in the empty state', () => {
    renderPicker([])
    expect(
      screen.getByRole('button', { name: i18n.t('popup.pairing.rescan') })
    ).toBeTruthy()
  })
})
