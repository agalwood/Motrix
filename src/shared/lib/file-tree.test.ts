import { describe, expect, it } from 'vitest'
import {
  buildFileTree,
  createFileTree,
  fileTreeMatches,
  fileTreeSelection,
  hasFileTreeStructure,
  toggleFileTreeRange,
  visibleFileTree,
} from './file-tree'

const files = [
  { index: 71, path: 'readme.txt', size: 5 },
  { index: 20, path: 'Film/subs/a.srt', size: 10 },
  { index: 3, path: 'Film/movie.mkv', size: 100 },
  { index: 99, path: '.pad/0', size: 200, padding: true },
  { index: 8, path: 'Music/a.flac', size: 20 },
]

describe('file tree', () => {
  it('groups folders before files without renumbering engine indices or counting padding', () => {
    const tree = buildFileTree(files)
    expect(tree.nodes.map((node) => node.name)).toEqual([
      'Film',
      'subs',
      'a.srt',
      'movie.mkv',
      'Music',
      'a.flac',
      'readme.txt',
    ])
    expect(tree.leaves.map((source) => files[source].index)).toEqual([
      20, 3, 8, 71,
    ])
    expect(tree.sizes.at(-1)).toBe(135)
    expect(
      visibleFileTree(tree, () => false).map((id) => tree.nodes[id].name)
    ).toEqual(['Film', 'Music', 'readme.txt'])
    expect(
      visibleFileTree(tree, (node) => node.name === 'Film').map(
        (id) => tree.nodes[id].name
      )
    ).toEqual(['Film', 'subs', 'movie.mkv', 'Music', 'readme.txt'])
  })

  it('computes directory tri-state and changes only a selected subtree', () => {
    const tree = buildFileTree(files)
    const selected = new Set([3, 71])
    const stats = fileTreeSelection(tree, selected)
    const film = tree.nodes[0]
    expect(stats.counts[film.end] - stats.counts[film.start]).toBe(1)
    expect(stats.size).toBe(105)
    const next = toggleFileTreeRange(tree, selected, film.start, film.end)
    expect(next).toEqual([3, 71, 20])
    expect(
      toggleFileTreeRange(tree, new Set(next), film.start, film.end)
    ).toEqual([71])
  })

  it('keeps search ancestors and scopes selection to matching files', () => {
    const tree = buildFileTree(files)
    const matches = fileTreeMatches(tree, 'SRT')!
    expect(
      visibleFileTree(tree, () => false, matches).map(
        (id) => tree.nodes[id].name
      )
    ).toEqual(['Film', 'subs', 'a.srt'])
    expect(
      toggleFileTreeRange(tree, new Set([71]), 0, tree.leaves.length, matches)
    ).toEqual([71, 20])
    expect(
      toggleFileTreeRange(
        tree,
        new Set([71, 20, 3]),
        0,
        tree.leaves.length,
        matches
      )
    ).toEqual([71, 3])
    expect(
      visibleFileTree(tree, () => true, fileTreeMatches(tree, 'missing'))
    ).toEqual([])
  })

  it('reuses structure on progress snapshots but detects rename, reorder, size and padding changes', () => {
    const tree = buildFileTree(files)
    expect(
      hasFileTreeStructure(
        tree,
        files.map((file) => ({ ...file, completedBytes: 42 })),
        true
      )
    ).toBe(true)
    for (const patch of [
      { path: 'renamed.txt' },
      { size: 99 },
      { padding: true },
      { index: 100 },
    ]) {
      expect(
        hasFileTreeStructure(
          tree,
          files.map((file, index) =>
            index === 0 ? { ...file, ...patch } : file
          ),
          true
        )
      ).toBe(false)
    }
    expect(hasFileTreeStructure(tree, [...files].reverse(), true)).toBe(false)
    expect(hasFileTreeStructure(tree, files, false)).toBe(false)
  })

  it('handles repeated basenames, Windows paths, Unicode and flat segment plans', () => {
    const input = [
      { index: 9, path: '資料\\第一集\\movie.mkv', size: 1 },
      { index: 2, path: '資料/第二集/movie.mkv', size: 1 },
    ]
    const tree = buildFileTree(input)
    expect(new Set(tree.nodes.map((node) => node.key)).size).toBe(
      tree.nodes.length
    )
    expect(tree.folders).toBe(3)
    expect(buildFileTree(input, false).nodes.map((node) => node.name)).toEqual(
      input.map((file) => file.path)
    )
  })

  it('handles deep paths without recursive traversal', () => {
    const tree = buildFileTree([
      { index: 8, path: `${'x/'.repeat(3000)}leaf`, size: 1 },
    ])
    expect(tree.nodes).toHaveLength(3001)
    expect(visibleFileTree(tree, () => false)).toHaveLength(1)
    expect(visibleFileTree(tree, () => true)).toHaveLength(3001)
    expect(tree.nodes[0].end).toBe(1)
  })

  it('yields while building a 100,000-file manifest and only flattens open branches', () => {
    const large = Array.from({ length: 100_000 }, (_, i) => ({
      index: i * 2,
      path: `collection/part-${Math.floor(i / 100)}/${i}.bin`,
      size: 1,
    }))
    const iterator = createFileTree(large)
    let result = iterator.next()
    let batches = 0
    while (!result.done) {
      batches++
      result = iterator.next()
    }
    const tree = result.value
    expect(batches).toBeGreaterThan(500)
    expect(tree.leaves).toHaveLength(100_000)
    expect(tree.nodes).toHaveLength(101_001)
    expect(visibleFileTree(tree, () => false)).toEqual([0])
    const selected = toggleFileTreeRange(tree, new Set(), 0, tree.leaves.length)
    expect(selected).toHaveLength(100_000)
    expect(selected.at(-1)).toBe(199_998)
    expect(fileTreeSelection(tree, new Set(selected)).size).toBe(100_000)
  })
})
