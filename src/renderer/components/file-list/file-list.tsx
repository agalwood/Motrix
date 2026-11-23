import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import type { VirtualListHandle } from '@renderer/components/desktop-kit/virtual-list/types'
import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  SearchIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { cn } from '@renderer/lib/utils'
import {
  type FileTreeNode,
  fileTreeMatches,
  fileTreeSelection,
  toggleFileTreeRange,
  visibleFileTree,
} from '@shared/lib/file-tree'
import { extractExtension } from '@shared/lib/path-ext'
import type { BaseFileRow } from '@shared/types/file-row'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useFileTree } from './use-file-tree'

interface FileListProps<T extends BaseFileRow = BaseFileRow> {
  files: T[]
  selectedIndices: number[]
  onSelectionChange?: (indices: number[]) => void
  readOnly?: boolean
  /** Media segment plans are flat; torrent paths form a directory tree. */
  hierarchical?: boolean
  scrollbar?: 'native' | 'custom'
  className?: string
  headerSlot?: ReactNode
  headerClassName?: string
  showColumnHeaders?: boolean
  renderRowTrailing?: (file: T) => ReactNode
  rowTrailingLabel?: string
  renderRowSize?: (file: T) => ReactNode
  renderRowActions?: (file: T) => ReactNode
}

export function FileList<T extends BaseFileRow = BaseFileRow>({
  files,
  selectedIndices,
  onSelectionChange,
  readOnly = false,
  hierarchical = true,
  scrollbar = 'native',
  className,
  headerSlot,
  headerClassName,
  showColumnHeaders = true,
  renderRowTrailing,
  rowTrailingLabel,
  renderRowSize,
  renderRowActions,
}: FileListProps<T>) {
  const { formatBytes } = useByteFormat()
  const { t } = useTranslation()
  const { tree, ready, displayFiles } = useFileTree(files, hierarchical)
  const listRef = useRef<VirtualListHandle>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [expansion, setExpansion] = useState<{
    all?: boolean
    overrides: Map<string, boolean>
  }>({ overrides: new Map() })
  const [activeKey, setActiveKey] = useState<string>()
  const id = useId()
  const minWidth = renderRowTrailing ? 'min-w-[384px]' : 'min-w-[320px]'
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices])
  const selection = useMemo(
    () => fileTreeSelection(tree, selectedSet),
    [tree, selectedSet]
  )
  const matches = useMemo(
    () => fileTreeMatches(tree, deferredQuery),
    [tree, deferredQuery]
  )
  const isExpanded = useCallback(
    (node: FileTreeNode) =>
      expansion.overrides.get(node.key) ??
      expansion.all ??
      tree.leaves.length <= 200,
    [expansion, tree]
  )
  const rows = useMemo(
    () => visibleFileTree(tree, isExpanded, matches),
    [tree, isExpanded, matches]
  )
  const getId = useCallback((nodeId: number) => tree.nodes[nodeId].key, [tree])
  const activeIndex = useMemo(
    () =>
      Math.max(
        0,
        rows.findIndex((nodeId) => tree.nodes[nodeId].key === activeKey)
      ),
    [rows, tree, activeKey]
  )
  const count = selection.counts[tree.leaves.length]
  const scopeCount = matches ? matches[tree.leaves.length] : tree.leaves.length
  const scopeSelection = useMemo(() => {
    if (!matches) return selection.counts
    const counts = new Uint32Array(tree.leaves.length + 1)
    for (let i = 0; i < tree.leaves.length; i++) {
      counts[i + 1] =
        counts[i] +
        (matches[i + 1] !== matches[i]
          ? selection.counts[i + 1] - selection.counts[i]
          : 0)
    }
    return counts
  }, [tree, selection, matches])
  const scopeSelected = scopeSelection[tree.leaves.length]
  const busy = !ready || query !== deferredQuery
  const showTools = tree.folders > 0 || files.length > 20 || query.length > 0

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    const measure = () => setHeaderHeight(header.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  function toggleFolder(node: FileTreeNode) {
    setExpansion((previous) => ({
      ...previous,
      overrides: new Map(previous.overrides).set(node.key, !isExpanded(node)),
    }))
  }

  function toggleSelection(start: number, end: number) {
    if (readOnly || busy || !onSelectionChange) return
    onSelectionChange(
      toggleFileTreeRange(tree, selectedSet, start, end, matches)
    )
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (
      (target !== event.currentTarget &&
        target.getAttribute('role') !== 'treeitem') ||
      !rows.length
    )
      return
    const node = tree.nodes[rows[activeIndex]]
    let next = activeIndex
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    switch (event.key) {
      case 'ArrowDown':
        next++
        break
      case 'ArrowUp':
        next--
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
      case rtl ? 'ArrowLeft' : 'ArrowRight':
        if (node.source < 0 && !matches && !isExpanded(node)) toggleFolder(node)
        else if (node.source < 0) next++
        break
      case rtl ? 'ArrowRight' : 'ArrowLeft':
        if (node.source < 0 && !matches && isExpanded(node)) toggleFolder(node)
        else if (node.parent >= 0) next = rows.indexOf(node.parent)
        break
      case 'Enter':
        if (node.source < 0 && !matches) toggleFolder(node)
        break
      case ' ':
        toggleSelection(node.start, node.end)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    next = Math.max(0, Math.min(rows.length - 1, next))
    setActiveKey(tree.nodes[rows[next]].key)
    listRef.current?.scrollToIndex(next)
  }

  return (
    <VirtualList<number>
      ref={listRef}
      scrollbar={scrollbar}
      items={rows}
      getId={getId}
      rowHeight={32}
      headerHeight={headerHeight}
      activeIndex={activeIndex}
      className={cn('@container/file-list h-full w-full', className)}
      contentProps={{
        role: 'tree',
        tabIndex: 0,
        'aria-label': t('task.torrent.column.name'),
        'aria-multiselectable': true,
        'aria-busy': busy,
        'aria-activedescendant': rows.length
          ? `${id}-${rows[activeIndex]}`
          : undefined,
        onKeyDown,
        className:
          'outline-none [&:focus-visible_[data-active=true]]:ring-2 [&:focus-visible_[data-active=true]]:ring-inset [&:focus-visible_[data-active=true]]:ring-ring',
      }}
      renderHeader={() => (
        <div
          ref={headerRef}
          className={cn(
            'sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-xs text-muted-foreground',
            minWidth,
            headerClassName
          )}
        >
          <div className="flex items-center gap-2">
            {!readOnly && (
              <Checkbox
                checked={scopeCount > 0 && scopeSelected === scopeCount}
                indeterminate={scopeSelected > 0 && scopeSelected < scopeCount}
                disabled={busy || !scopeCount}
                onCheckedChange={() => toggleSelection(0, tree.leaves.length)}
                aria-label={t(
                  matches
                    ? 'task.torrent.selectMatching'
                    : 'task.torrent.selectAll'
                )}
              />
            )}
            <span className="min-w-0 flex-1 tabular-nums">
              {ready
                ? `${t('task.torrent.fileSelected', { count })} · ${formatBytes(selection.size)}`
                : t('common.loading')}
            </span>
            {headerSlot}
          </div>
          {showTools && (
            <div className="mt-2 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute start-2 top-1.5 size-3.5" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    listRef.current?.scrollToOffset(0)
                  }}
                  onKeyDown={(event) => {
                    // Searching inside New Task must not submit the download.
                    if (event.key === 'Enter') event.preventDefault()
                    if (event.key === 'Escape' && query) {
                      event.preventDefault()
                      event.stopPropagation()
                      setQuery('')
                    }
                  }}
                  aria-label={t('task.torrent.searchFiles')}
                  placeholder={t('task.torrent.searchFiles')}
                  className="h-7 ps-7 text-xs!"
                />
              </div>
              {matches && (
                <span className="shrink-0 tabular-nums">
                  {scopeCount.toLocaleString()} /{' '}
                  {tree.leaves.length.toLocaleString()}
                </span>
              )}
              {tree.folders > 0 && !matches && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      setExpansion({ all: true, overrides: new Map() })
                    }
                  >
                    {t('task.torrent.expandAll')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setExpansion({ all: false, overrides: new Map() })
                      listRef.current?.scrollToOffset(0)
                    }}
                  >
                    {t('task.torrent.collapseAll')}
                  </Button>
                </>
              )}
            </div>
          )}
          {showColumnHeaders && (
            <div className="mt-2 flex items-center gap-2 font-medium">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t('task.torrent.column.name')}
              </span>
              <span className="hidden w-14 shrink-0 truncate @min-[480px]/file-list:block">
                {t('task.torrent.column.type')}
              </span>
              <span className="w-18 shrink-0 truncate text-end">
                {t('task.torrent.column.size')}
              </span>
              {renderRowTrailing && (
                <span className="w-14 shrink-0 truncate text-end">
                  {rowTrailingLabel}
                </span>
              )}
              {renderRowActions && <span className="w-7 shrink-0" />}
            </div>
          )}
          {ready && !rows.length && (
            <p className="pt-2" role="status">
              {t('task.torrent.noMatchingFiles')}
            </p>
          )}
        </div>
      )}
      renderRow={({ item: nodeId, index: rowIndex }) => {
        const node = tree.nodes[nodeId]
        const folder = node.source < 0
        const file = folder ? undefined : displayFiles[node.source]
        const selected = scopeSelection[node.end] - scopeSelection[node.start]
        const nodeCount = matches
          ? matches[node.end] - matches[node.start]
          : node.end - node.start
        const checked = selected === nodeCount
        const mixed = selected > 0 && !checked
        const expanded = folder && (!!matches || isExpanded(node))
        const fullPath = file?.path ?? node.key.slice(2, -1)
        const fileType = file ? extractExtension(file.path).slice(1) || '—' : ''
        return (
          <div
            id={`${id}-${nodeId}`}
            role="treeitem"
            tabIndex={-1}
            aria-label={fullPath}
            aria-level={node.depth + 1}
            aria-posinset={node.position}
            aria-setsize={node.siblings}
            aria-expanded={folder ? expanded : undefined}
            aria-checked={mixed ? 'mixed' : checked}
            aria-disabled={busy || undefined}
            data-active={rowIndex === activeIndex}
            onFocusCapture={() => setActiveKey(node.key)}
            className={cn(
              'flex h-full items-center gap-2 border-b border-border/50 px-3',
              minWidth,
              'hover:bg-accent/40',
              checked && 'bg-accent/30'
            )}
          >
            <Checkbox
              checked={checked}
              indeterminate={mixed}
              tabIndex={-1}
              onCheckedChange={() => toggleSelection(node.start, node.end)}
              disabled={readOnly || busy}
              aria-label={fullPath}
            />
            <div
              className="flex min-w-0 flex-1 items-center gap-1"
              style={{ paddingInlineStart: Math.min(node.depth, 12) * 16 }}
            >
              {tree.folders > 0 &&
                (folder ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={fullPath}
                    aria-expanded={expanded}
                    disabled={!!matches}
                    className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground"
                    onClick={() => {
                      setActiveKey(node.key)
                      toggleFolder(node)
                      listRef.current
                        ?.getContainerRef()
                        ?.querySelector<HTMLElement>('[role=tree]')
                        ?.focus({ preventScroll: true })
                    }}
                  >
                    {expanded ? (
                      <ChevronDownIcon className="size-3.5" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 rtl:rotate-180" />
                    )}
                  </button>
                ) : (
                  <span className="w-4 shrink-0" />
                ))}
              {folder && (
                <FolderIcon className="me-1 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <MiddleEllipsis
                text={node.name}
                fullText={fullPath}
                dir="auto"
                maxChars={80}
                className={cn(
                  'min-w-0 font-sans! text-xs',
                  folder && 'font-medium'
                )}
              />
              {folder && (
                <span className="ms-1 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {nodeCount.toLocaleString()}
                </span>
              )}
            </div>
            <span
              className="hidden w-14 shrink-0 truncate text-xs text-muted-foreground @min-[480px]/file-list:block"
              dir="ltr"
              title={fileType || undefined}
            >
              {fileType}
            </span>
            <span className="w-18 shrink-0 truncate text-end text-xs tabular-nums text-muted-foreground">
              {file && renderRowSize
                ? renderRowSize(file)
                : formatBytes(tree.sizes[node.end] - tree.sizes[node.start])}
            </span>
            {renderRowTrailing && (
              <span className="w-14 shrink-0 truncate text-end">
                {file && renderRowTrailing(file)}
              </span>
            )}
            {renderRowActions && (
              <div className="w-7 shrink-0">
                {file && ready && renderRowActions(file)}
              </div>
            )}
          </div>
        )
      }}
    />
  )
}
