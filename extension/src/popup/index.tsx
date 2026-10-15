import '@/styles/globals.css'
import { createRoot } from 'react-dom/client'
import { App } from '@/popup/App'
import { initI18n } from '@/shared/i18n'
import { LocaleProvider } from '@/shared/LocaleProvider'
import { initTheme } from '@/shared/theme'

initTheme()

const root = document.getElementById('root')
void initI18n().then(() => {
  if (root)
    createRoot(root).render(
      <LocaleProvider>
        <App />
      </LocaleProvider>
    )
})
