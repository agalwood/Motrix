export interface SettingsCardDialogProps {
  open: boolean
  onClose: () => void
  onClosed?: () => void
  labelKey: string
  descKey: string
}
