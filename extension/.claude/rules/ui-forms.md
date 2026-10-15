---
paths:
  - "src/options/**"
  - "src/popup/**"
  - "src/components/**"
  - "src/shared/locales/**"
  - "src/styles/**"
---

# Settings and popup form conventions

## Start from the existing surface

- Inspect the nearest comparable field and reuse its structure before adding a control. Match the current page's alignment, sizing, spacing, and interaction model.
- Use primitives from `src/components/ui/`. Do not introduce a parallel select, switch, field, or button style for one feature.
- Feature-specific components may own validation and capability checks. Their layout must still follow the host surface.

## Full settings page

- Group related preferences in `SettingSection` and `FieldGroup`; do not create a section heading for every single setting.
- Use `FormField` for React Hook Form bindings, then `Field orientation="responsive"` with `FieldContent` and `FieldLabel` for ordinary inputs and selects. Labels and descriptions precede the control; the shared container breakpoint stacks the row on narrow screens.
- Follow `src/options/sections/AppearanceSection.tsx` for select rows: `SelectTrigger` uses `min-w-48` and the shared default height. Do not force a select to span the full settings panel with `w-full`.
- Use `Field orientation="horizontal"` for switches and `orientation="vertical"` for multiline inputs such as a domain list.
- Put supporting copy in `FieldDescription` beside the label. Associate labels with the actual control ID and connect descriptions with `aria-describedby`.
- Use the existing `SettingsTabForm` Apply/Cancel flow; changing a field alone must not silently save the full settings form.

## Popup quick settings

- Binary preferences use `QuickSettingRow` in `src/popup/QuickSettingsPanel.tsx`, with a label and concise explanation on the leading side and a switch on the trailing side.
- Do not add a standalone full-width select or custom card for a binary preference among switch rows. An underlying two-value enum can map to the switch when its on/off meanings are clear; download confirmation maps on to `confirm` and off to `direct`.
- For a preference with more than two real choices, use a shared compact row pattern and check that its control fits the popup before shipping.
- Keep the existing row spacing, typography, dividers, disabled treatment, and immediate per-setting persistence. Do not reuse long settings-page paragraphs when concise popup copy is sufficient.

## Scrollable popup forms

- Bound dialogs to the viewport and keep headers and actions outside the scrolling form body.
- Use shrinkable single-column grids (`min-w-0`, `grid-cols-1`) for fields. Long URLs, request headers, and input values must not widen the dialog.
- Reserve space inside the scroll viewport for the shared controls' outer focus rings and expanded switch hit targets. The current controls need at least 3px for focus rings and 12px at the inline edges for switch hit targets; do not place controls flush against a clipping boundary.
- Form bodies scroll vertically only. Fix content sizing and padding before applying `overflow-x-hidden`; hiding overflow alone must not clip controls or focus indicators.
- Verify expanded request options, keyboard focus at the first and last fields, and long values at 400 × 600 and a narrower viewport. Check both confirmation and quick-add dialogs when changing their shared fields.

## Behavior, localization, and verification

- State consequential behavior near the control, including automatic popup opening and the meaning of turning a preference off.
- Explain unavailable controls using actual platform capabilities. Old browser versions and unsupported Safari functionality need their respective explanations.
- A previously enabled preference must remain possible to turn off when enabling it is no longer supported. Loading or an in-flight save may temporarily disable both directions.
- Add user-facing copy to every supported locale with matching interpolation placeholders. Reuse existing keys when their meaning is unchanged.
- Preserve RTL layout with logical spacing and alignment (`ps`/`pe`, `start`/`end`). URLs, request headers, and similar protocol values remain LTR; filenames may use `dir="auto"`.
- Inspect the changed page in a browser at the real popup size (400 × 600) or settings layout, including a narrow layout when the row changes. Check wrapping, scrolling, labels, and control alignment.
- Reuse relevant interaction, accessibility, capability, and locale-parity tests. Do not add brittle class-name or snapshot tests solely to duplicate the layout implementation.
