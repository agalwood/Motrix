# Panel toolbars

`Toolbar` owns the saved Liquid Glass preference, standard/compact density,
tooltips and Base UI's roving keyboard focus. Compose it from `ToolbarGroup`,
`ToolbarButton`, `ToolbarLink`, `ToolbarSeparator` and `ToolbarSearch`.
Keep transport calls, route changes, filtering and action priority in the page.

```tsx
<Toolbar label={t('plugins.title')}>
  <ToolbarGroup>
    <ToolbarButton label={t('plugins.install.title')} onClick={openInstaller}>
      <Plus aria-hidden="true" />
    </ToolbarButton>
    <ToolbarLink
      label={t('plugins.diagnostics.title')}
      render={<Link to="/plugins/diagnostics" />}
    >
      <Workflow aria-hidden="true" />
    </ToolbarLink>
  </ToolbarGroup>
  <ToolbarSearch
    value={query}
    onValueChange={setQuery}
    label={t('plugins.search')}
    clearLabel={t('common.clearSearch')}
  />
</Toolbar>
```

- Place the toolbar in `PanelShell.actions`, with `actionsDraggable` and
  `actionsClassName="min-w-0 flex-1"` when it should occupy the available width.
  Groups remain non-draggable; blank space can move the window.
- `ToolbarButton.label` supplies both an accessible name and a tooltip. When
  composing a menu/popover that already owns its tooltip, pass `aria-label`
  instead. Button refs and Base UI `render` composition are supported.
- Use `ToolbarLink` for navigation so link semantics and modifier clicks survive.
- `ToolbarSearch` expands and focuses on activation. Escape clears text, then
  collapses an empty field and returns focus. Empty fields collapse on blur;
  populated fields remain visible. `width` is a preferred width that may shrink.
- Optional `expanded` / `onExpandedChange` let a feature coordinate its responsive
  layout. `keepExpanded` preserves active filters or an open popup. `leading`
  receives an anchor ref and `collapseIfIdle` for portaled filter controls;
  `onEmptyEscape` can return focus to that filter trigger. See Downloads.
- Material overrides belong on `Toolbar.glassEnabled`, primarily for isolated
  previews. By default all groups follow the saved setting and accessibility
  preferences together. No page should reproduce material CSS.

Toolbar arrow keys move between controls, skipping disabled actions. Search
inputs retain their editing keys. Dynamic overflow priorities stay with the
feature: Downloads can move lower-priority commands into its existing menu,
while smaller toolbars can keep their actions visible as search shrinks.
