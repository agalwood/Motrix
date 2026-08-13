---
description: Height-chain and sticky-scroll rules for panels inside SidebarInset
paths: ["src/renderer/routes/**/*.tsx", "src/renderer/layouts/app-layout*.tsx", "src/renderer/components/ui/sidebar*.tsx", "src/renderer/components/desktop-kit/panel/**", "src/renderer/components/settings-kit/**/*.tsx"]
---

# Panel Layout

Pages inside `SidebarInset` stay within the viewport. The document and panel
shell do not scroll; the innermost data region owns scrolling.

## Height chain

Every flex ancestor between the viewport clamp and the data region must allow
its child to shrink:

```text
SidebarProvider  h-svh overflow-hidden
  SidebarInset   flex-1 min-h-0 overflow-hidden
    PanelShell   h-full flex flex-col
      content    flex-1 min-h-0 flex flex-col
        Tabs     flex-1 min-h-0 flex flex-col
          list   shrink-0
          content flex min-h-0 flex-1
            panel flex min-h-0 flex-1 flex-col
              fixed regions shrink-0
              data region flex min-h-0 flex-1 overflow-auto
```

`flex-1` without `min-h-0` is insufficient because the default intrinsic
minimum height lets content grow the page.

## Scrolling and sticky content

- The chain has exactly one `overflow-auto`: the leaf data region. Ancestors
  use `overflow-hidden` where a clamp is needed; do not make `PanelShell`,
  `Tabs`, or `TabsContent` a competing scroller.
- Non-scrolling headers, filters, summaries, tab lists, and footers use
  `shrink-0`.
- A sticky column header is the first child inside the scroll region so
  `sticky top-0` resolves against the intended scroller.
- Sticky content needs an opaque background, `z-10`, and `border-b`; a separate
  separator sibling scrolls away and does not preserve the boundary.
- Under tabs, keep `TabsContent` as `flex min-h-0 flex-1` and its panel as
  `flex min-h-0 flex-1 flex-col` so both axes remain bounded.

When changing a panel, verify that the page has no document scrollbar, only the
data region scrolls, sticky headers remain readable, and the inset/footer stay
visible at short viewport heights.
