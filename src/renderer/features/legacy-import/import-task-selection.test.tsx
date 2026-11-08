import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { LegacyImportItem } from '@shared/schemas/legacy-import'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import {
  ImportTaskSelection,
  initialExpandedGroups,
} from './import-task-selection'

const items: LegacyImportItem[] = [
  {
    itemId: 'a',
    name: 'first.zip',
    type: 'http',
    selectable: true,
    reason: 'fresh-download-required',
  },
  {
    itemId: 'b',
    name: 'second.zip',
    type: 'http',
    selectable: true,
    reason: 'fresh-download-required',
  },
  {
    itemId: 'skipped',
    name: 'previous.zip',
    type: 'http',
    selectable: false,
    reason: 'already-imported',
  },
  {
    itemId: 'torrent',
    name: 'linux.iso',
    type: 'bt',
    selectable: true,
    reason: 'verification-required',
  },
]

function Harness({ tasks = items }: { tasks?: LegacyImportItem[] }) {
  const [selected, setSelected] = useState(
    new Set(tasks.filter((item) => item.selectable).map((item) => item.itemId))
  )
  const [expanded, setExpanded] = useState(initialExpandedGroups(tasks))
  const [query, setQuery] = useState('')
  return (
    <>
      <output aria-label="Selected">{selected.size}</output>
      <ImportTaskSelection
        items={tasks}
        selected={selected}
        setSelected={setSelected}
        expanded={expanded}
        setExpanded={setExpanded}
        query={query}
        setQuery={setQuery}
        busy={false}
        running={false}
        chooseTorrent={() => {}}
      />
    </>
  )
}

describe('migration content groups', () => {
  it('keeps selection and disclosure independent, counts skipped tasks, and exposes a mixed group', () => {
    render(<Harness />)
    const group = screen.getByRole('checkbox', { name: 'Select Direct links' })
    const disclosure = screen.getByRole('button', { name: 'Direct links' })
    expect(group).toBeChecked()
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(
        disclosure.closest('[data-import-group]') as HTMLElement
      ).getByText('3 tasks')
    ).toBeVisible()
    fireEvent.click(disclosure)
    expect(group).toBeChecked()
    const skipped = screen.getByRole('checkbox', { name: 'previous.zip' })
    expect(skipped).toHaveAttribute('aria-disabled', 'true')
    expect(skipped).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'first.zip' }))
    expect(group).toHaveAttribute('aria-checked', 'mixed')
    expect(group.querySelector('[data-icon="subtract"]')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2')
    fireEvent.click(disclosure)
    expect(group).toHaveAttribute('aria-checked', 'mixed')
    fireEvent.click(group)
    expect(group).toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('3')
    expect(
      screen.getByRole('checkbox', { name: 'Select Torrent downloads' })
    ).toBeChecked()
  })

  it('changes the whole eligible group while search filters only its visible rows', () => {
    const tasks: LegacyImportItem[] = Array.from(
      { length: 21 },
      (_, index) => ({
        itemId: `task-${index}`,
        name: index === 0 ? 'match.zip' : `hidden-${index}.zip`,
        type: 'http',
        selectable: true,
        reason: 'fresh-download-required',
      })
    )
    tasks.push({
      itemId: 'skipped',
      name: 'skipped.zip',
      type: 'http',
      selectable: false,
      reason: 'already-imported',
    })
    render(<Harness tasks={tasks} />)
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Search downloads' }),
      { target: { value: 'match' } }
    )
    expect(
      screen.queryByRole('checkbox', { name: 'hidden-1.zip' })
    ).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Direct links' })
    )
    expect(screen.getByRole('status')).toHaveTextContent('0')
    fireEvent.click(screen.getByRole('checkbox', { name: 'match.zip' }))
    expect(
      screen.getByRole('checkbox', { name: 'Select Direct links' })
    ).toHaveAttribute('aria-checked', 'mixed')
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Direct links' })
    )
    expect(screen.getByRole('status')).toHaveTextContent('21')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(screen.getByRole('checkbox', { name: 'hidden-1.zip' })).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'skipped.zip' })
    ).not.toBeChecked()
  })

  it('does not allow a fully skipped group to enter the selection', () => {
    render(
      <Harness
        tasks={[
          {
            itemId: 'invalid',
            name: 'unreadable',
            type: 'unknown',
            selectable: false,
            reason: 'invalid-record',
          },
        ]}
      />
    )
    expect(
      screen.getByRole('checkbox', { name: 'Select Other downloads' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('checkbox', { name: 'unreadable' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('0')
    expect(screen.getByText('Couldn’t read this task')).toBeVisible()
  })
})
