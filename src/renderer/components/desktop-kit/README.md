# Desktop Kit

Motrix 2.0 的桌面交互组件库。提供虚拟滚动列表、框选（Marquee Selection）和多选能力，适配任意列表数据类型。

## 架构

三个独立模块 + 一个胶水 Hook：

```
                   使用侧代码
                       |
               useSelectableList (胶水 hook)
               /       |         \
   VirtualList   MarqueeOverlay   SelectionEngine
        |              |                |
 @tanstack/virtual  DOM events     Zustand store
                                  (纯逻辑，零 DOM)
```

- **SelectionEngine** — 纯逻辑 Zustand store，零 DOM/React 依赖，可独立测试
- **VirtualList** — `@tanstack/react-virtual` 封装，不感知选择
- **MarqueeOverlay** — 框选 UI 覆盖层，只输出索引范围
- **useSelectableList** — 唯一组合点，负责将三者接线

## 快速开始

```tsx
import { useSelectableList } from './hooks/use-selectable-list'
import { VirtualList } from './virtual-list/virtual-list'
import { MarqueeOverlay } from './marquee-selection/marquee-overlay'

interface Task {
  id: string
  name: string
}

function TaskList({ tasks }: { tasks: Task[] }) {
  const {
    listRef,
    listProps,
    marqueeProps,
    getRowProps,
    headerCheckbox,
    onKeyDown,
  } = useSelectableList({
    items: tasks,
    getId: (t) => t.id,
    rowHeight: 40,
  })

  return (
    <div onKeyDown={onKeyDown} tabIndex={0} style={{ position: 'relative' }}>
      <VirtualList
        ref={listRef}
        {...listProps}
        style={{ height: 500 }}
        renderHeader={() => (
          <div>
            <input
              type="checkbox"
              checked={headerCheckbox.checked}
              ref={(el) => {
                if (el) el.indeterminate = headerCheckbox.indeterminate
              }}
              onChange={headerCheckbox.onChange}
            />
            Name
          </div>
        )}
        renderRow={({ item, index }) => {
          const rp = getRowProps(index)
          return (
            <div
              style={{ background: rp.selected ? '#dbeafe' : 'transparent' }}
              onClick={rp.onClick}
            >
              <input
                type="checkbox"
                checked={rp.selected}
                onChange={() => {}}
                onClick={(e) => {
                  e.stopPropagation()
                  rp.onCheckboxChange()
                }}
              />
              {item.name}
            </div>
          )
        }}
      />
      <MarqueeOverlay {...marqueeProps} />
    </div>
  )
}
```

## API 参考

### `useSelectableList<T>(options)`

胶水 Hook，一次调用即可获得所有交互能力。

#### Options

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `items` | `T[]` | 必填 | 列表数据 |
| `getId` | `(item: T) => string` | 必填 | 从数据项提取唯一 ID |
| `rowHeight` | `number` | 必填 | 固定行高（px） |
| `headerHeight` | `number` | `0` | 表头高度（框选坐标偏移用） |
| `marquee` | `boolean` | `true` | 是否启用框选 |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `listRef` | `RefObject<VirtualListHandle>` | 传给 `VirtualList` 的 ref |
| `listProps` | `{ items, getId, rowHeight, scrollRef }` | 展开传给 `VirtualList` |
| `marqueeProps` | `MarqueeOverlayProps` | 展开传给 `MarqueeOverlay` |
| `selection` | `SelectionStore<T>` | Zustand store，可细粒度订阅 |
| `getRowProps(index)` | `(index: number) => RowProps` | 行级交互 props |
| `headerCheckbox` | `HeaderCheckboxState` | 表头全选 Checkbox 状态 |
| `onKeyDown` | `(e: KeyboardEvent) => void` | 绑定到列表容器 |

#### `getRowProps(index)` 返回值

| 字段 | 说明 |
|------|------|
| `selected` | 当前行是否选中 |
| `focused` | 当前行是否获得键盘焦点 |
| `onClick` | 行点击处理（支持 Ctrl/Cmd/Shift 修饰键） |
| `onCheckboxChange` | Checkbox toggle（不影响其他选中项） |

#### `headerCheckbox` 返回值

| 字段 | 说明 |
|------|------|
| `checked` | 全部选中时为 `true` |
| `indeterminate` | 部分选中时为 `true` |
| `onChange` | 全选/全不选切换 |

### `VirtualList<T>`

泛型虚拟滚动列表。固定行高，通过 `renderRow` 渲染每一行。

#### Props

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `items` | `T[]` | 必填 | 列表数据 |
| `getId` | `(item: T) => string` | 必填 | 唯一 ID 提取 |
| `rowHeight` | `number` | 必填 | 固定行高 |
| `overscan` | `number` | `5` | 视口外预渲染行数 |
| `scrollRef` | `RefObject<HTMLDivElement>` | — | 外部滚动容器 ref（`useSelectableList` 自动传入） |
| `renderRow` | `(props: RowRenderProps<T>) => ReactNode` | 必填 | 行渲染函数 |
| `renderHeader` | `() => ReactNode` | — | 表头插槽 |
| `renderEmpty` | `() => ReactNode` | — | 空状态插槽 |
| `className` | `string` | — | 容器 CSS 类名 |
| `style` | `CSSProperties` | — | 容器内联样式（**必须设置 height**） |

#### Ref Handle (`VirtualListHandle`)

| 方法 | 说明 |
|------|------|
| `scrollToIndex(index)` | 滚动到指定行 |
| `getScrollOffset()` | 当前滚动偏移量 |
| `getContainerRef()` | 滚动容器 DOM 引用 |

### `MarqueeOverlay`

框选覆盖层。绑定到滚动容器，拖拽时绘制半透明选框并输出索引范围。

#### Props

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `containerRef` | `RefObject<HTMLDivElement>` | 必填 | 滚动容器引用 |
| `rowHeight` | `number` | 必填 | 行高 |
| `totalCount` | `number` | 必填 | 总行数 |
| `headerHeight` | `number` | `0` | 表头偏移 |
| `enabled` | `boolean` | `true` | 启用/禁用 |
| `minDragDistance` | `number` | `5` | 最小拖拽距离（px） |
| `scrollGutter` | `number` | `100` | 自动滚动触发区域（px） |
| `scrollMaxSpeed` | `number` | `15` | 最大滚动速度（px/16ms） |
| `onSelectionChange` | `(start, end) => void` | 必填 | 拖拽中的索引范围回调 |
| `onSelectionEnd` | `() => void` | 必填 | 拖拽结束回调 |

### `createSelectionStore<T>(getId)`

SelectionEngine 的 Zustand store 工厂。适用于需要自定义选择逻辑或不使用 `useSelectableList` 的场景。

```typescript
const store = createSelectionStore<MyItem>((item) => item.id)
store.getState().setItems(myItems)
store.getState().select('item-1')
```

#### Store State

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | `T[]` | 当前数据源 |
| `selectedIds` | `Set<string>` | 选中项 ID 集合 |
| `focusedIndex` | `number \| null` | 键盘焦点行索引 |
| `lastActionIndex` | `number \| null` | 上次操作行索引（Shift 范围选择锚点） |

#### Store Methods

| 方法 | 说明 |
|------|------|
| `select(id)` | 单选，清除其他 |
| `toggle(id)` | 切换选中，不影响其他 |
| `rangeSelect(toIndex)` | 从 `lastActionIndex` 到目标行范围选中 |
| `selectAll()` | 全选 |
| `clearSelection()` | 清空选择 |
| `setItems(items)` | 更新数据源（自动剪除无效选中） |
| `marqueeSelect(start, end)` | 框选预览（合并 `preservedIds`） |
| `marqueeEnd()` | 框选确认 |
| `moveFocus(delta)` | 移动键盘焦点（+1/-1） |
| `focusedSelect()` | 切换焦点行选中 |
| `shiftMoveFocus(delta)` | 移动焦点 + 扩展选择 |
| `isSelected(id)` | 查询是否选中 |
| `selectedCount()` | 选中数量 |

## 交互一览

### 鼠标

| 操作 | 行为 |
|------|------|
| 单击行 | 单选（清除其他） |
| `Ctrl/Cmd + 单击` | Toggle（不影响其他） |
| `Shift + 单击` | 范围选择（从上次操作到当前行） |
| 单击 Checkbox | Toggle（不影响其他） |
| 表头 Checkbox | 全选/全不选 |
| 拖拽框选 | 框中的行全部选中 |

### 键盘

| 按键 | 行为 |
|------|------|
| `↑` / `↓` | 移动焦点（不改变选中） |
| `Space` | 切换焦点行选中 |
| `Shift + ↑/↓` | 移动焦点 + 扩展选择 |
| `Ctrl/Cmd + A` | 全选 |
| `Escape` | 清空选择 |

## 目录结构

```
desktop-kit/
├── selection/
│   ├── types.ts                         # SelectionState<T>, SelectionStore<T>
│   ├── create-selection-store.ts        # Zustand store 工厂
│   └── create-selection-store.test.ts   # 32 个单元测试
├── virtual-list/
│   ├── types.ts                         # VirtualListProps<T>, Handle
│   ├── virtual-list.tsx                  # @tanstack/react-virtual 封装
│   └── virtual-list.test.tsx             # 4 个组件测试
├── marquee-selection/
│   ├── types.ts                         # MarqueeOverlayProps, DragState
│   ├── use-auto-scroll.ts              # 边缘自动滚动 hook
│   ├── marquee-overlay.tsx              # 框选 UI 层
│   └── marquee-overlay.test.tsx          # 4 个组件测试
├── hooks/
│   ├── use-selectable-list.ts           # 胶水 hook
│   └── use-selectable-list.test.tsx     # 12 个集成测试
└── demo/
    └── selectable-list-demo.tsx           # 交互演示页
```

## 设计原则

1. **三层解耦** — SelectionEngine 不依赖 DOM，VirtualList 不感知选择，MarqueeOverlay 只输出索引
2. **泛型适配** — `<T>` + `getId` 函数适配任意数据结构
3. **数学计算替代 DOM 查询** — 框选通过 `Math.floor(offset / rowHeight)` 计算索引，不查询 DOM，虚拟化无死角
4. **固定行高** — 所有列表场景统一固定行高，使索引计算为 O(1)
5. **O(1) ID 查找** — 内部维护 `Map<id, index>`，select/toggle 不做线性扫描

## 运行 Demo

```bash
pnpm start
```

应用启动后即显示三个 Demo：
- **File Browser** — 500 个文件，多列表头，框选 + 键盘导航
- **Download Manager** — 200 个下载任务，进度条 + 状态色
- **Minimal List** — 10 个项目，空状态切换

## 运行测试

```bash
pnpm test            # 运行一次
pnpm run test:watch  # 监听模式
```
