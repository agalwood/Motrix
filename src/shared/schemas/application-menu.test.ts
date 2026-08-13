import { describe, expect, it } from 'vitest'
import {
  applicationMenuNodeSchema,
  applicationMenuSnapshotSchema,
  executeApplicationMenuItemRequestSchema,
} from './application-menu'

const snapshot = {
  revision: 7,
  items: [
    {
      id: 'menubar.task',
      type: 'submenu',
      label: 'Task',
      enabled: true,
      visible: true,
      children: [
        {
          id: 'task.pause',
          type: 'normal',
          label: 'Pause',
          accelerator: 'CommandOrControl+P',
          enabled: false,
          visible: true,
        },
        {
          id: 'task.mode.fast',
          type: 'radio',
          label: 'Fast',
          enabled: true,
          visible: true,
          checked: true,
          radioGroupId: 'task.mode',
        },
      ],
    },
  ],
} as const

describe('applicationMenuSnapshotSchema', () => {
  it('parses a recursive application-menu snapshot', () => {
    expect(applicationMenuSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('supports every menu node type', () => {
    for (const type of [
      'normal',
      'submenu',
      'separator',
      'checkbox',
      'radio',
    ]) {
      expect(
        applicationMenuNodeSchema.safeParse({
          id: `item.${type}`,
          type,
          label: type === 'separator' ? '' : type,
          enabled: true,
          visible: true,
          ...(type === 'checkbox' || type === 'radio'
            ? { checked: false }
            : {}),
          ...(type === 'radio' ? { radioGroupId: 'item.mode' } : {}),
          ...(type === 'submenu' ? { children: [] } : {}),
        }).success
      ).toBe(true)
    }
  })

  it('rejects unknown keys at the snapshot and every recursive node', () => {
    expect(
      applicationMenuSnapshotSchema.safeParse({ ...snapshot, extra: true })
        .success
    ).toBe(false)
    expect(
      applicationMenuSnapshotSchema.safeParse({
        ...snapshot,
        items: [
          {
            ...snapshot.items[0],
            children: [
              {
                ...snapshot.items[0].children[0],
                injected: 'value',
              },
            ],
          },
        ],
      }).success
    ).toBe(false)
  })

  it('rejects invalid revisions and node types', () => {
    expect(
      applicationMenuSnapshotSchema.safeParse({ ...snapshot, revision: -1 })
        .success
    ).toBe(false)
    expect(
      applicationMenuSnapshotSchema.safeParse({ ...snapshot, revision: 1.5 })
        .success
    ).toBe(false)
    expect(
      applicationMenuSnapshotSchema.safeParse({
        ...snapshot,
        items: [{ ...snapshot.items[0], type: 'heading' }],
      }).success
    ).toBe(false)
  })

  it('enforces checkable, radio-group, and submenu structure', () => {
    expect(
      applicationMenuNodeSchema.safeParse({
        id: 'radio.missing-group',
        type: 'radio',
        label: 'Radio',
        enabled: true,
        visible: true,
        checked: true,
      }).success
    ).toBe(false)
    expect(
      applicationMenuNodeSchema.safeParse({
        id: 'normal.with-children',
        type: 'normal',
        label: 'Normal',
        enabled: true,
        visible: true,
        children: [],
      }).success
    ).toBe(false)
  })

  it('rejects empty and oversized node identifiers', () => {
    for (const id of ['', 'x'.repeat(257)]) {
      expect(
        applicationMenuSnapshotSchema.safeParse({
          ...snapshot,
          items: [{ ...snapshot.items[0], id }],
        }).success
      ).toBe(false)
    }

    expect(
      applicationMenuNodeSchema.safeParse({
        ...snapshot.items[0].children[1],
        radioGroupId: 'x'.repeat(257),
      }).success
    ).toBe(false)
  })
})

describe('executeApplicationMenuItemRequestSchema', () => {
  const request = {
    itemId: 'task.pause',
    revision: 7,
    trigger: 'menu',
    selectedTaskId: 'task-1',
    modifiers: {
      alt: false,
      control: true,
      meta: false,
      shift: false,
    },
  } as const

  it('parses the strict execution request', () => {
    expect(executeApplicationMenuItemRequestSchema.parse(request)).toEqual(
      request
    )
    expect(
      executeApplicationMenuItemRequestSchema.parse({
        itemId: 'task.pause',
        revision: 7,
        trigger: 'menu',
        selectedTaskId: null,
      })
    ).toEqual({
      itemId: 'task.pause',
      revision: 7,
      trigger: 'menu',
      selectedTaskId: null,
    })
  })

  it('rejects unknown request and modifier keys', () => {
    expect(
      executeApplicationMenuItemRequestSchema.safeParse({
        ...request,
        extra: true,
      }).success
    ).toBe(false)
    expect(
      executeApplicationMenuItemRequestSchema.safeParse({
        ...request,
        modifiers: { ...request.modifiers, super: true },
      }).success
    ).toBe(false)
  })

  it('requires a complete modifier snapshot and the menu trigger', () => {
    expect(
      executeApplicationMenuItemRequestSchema.safeParse({
        ...request,
        modifiers: { alt: false },
      }).success
    ).toBe(false)
    expect(
      executeApplicationMenuItemRequestSchema.safeParse({
        ...request,
        trigger: 'keyboard',
      }).success
    ).toBe(false)
    const { selectedTaskId: _selectedTaskId, ...withoutContext } = request
    expect(
      executeApplicationMenuItemRequestSchema.safeParse(withoutContext).success
    ).toBe(false)
  })

  it('rejects empty or oversized item IDs and fractional revisions', () => {
    for (const itemId of ['', 'x'.repeat(257)]) {
      expect(
        executeApplicationMenuItemRequestSchema.safeParse({
          ...request,
          itemId,
        }).success
      ).toBe(false)
    }
    expect(
      executeApplicationMenuItemRequestSchema.safeParse({
        ...request,
        revision: 1.5,
      }).success
    ).toBe(false)
  })
})
