import { LanguageSync } from '@renderer/components/language-sync'
import { ThemeSync } from '@renderer/components/theme-sync'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import {
  fnosFileAction,
  fnosPlatformConfig,
  pickFnosDirectory,
} from '@renderer/platform/fnos'
import { FnosEntry } from '@renderer/platform/fnos-entry'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { createWebServices } from '@renderer/platform/web-services'
import { ThemeProvider } from 'next-themes'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

useOperatorSession.setState({
  state: 'authenticated',
  status: { authed: true, mode: 'fnosGateway', canLogout: false },
})
function App() {
  const [result, setResult] = useState('')
  const run = async (work: Promise<unknown>) => {
    try {
      setResult(JSON.stringify(await work))
    } catch (error) {
      setResult(String(error))
    }
  }
  return (
    <PlatformServicesProvider services={createWebServices()}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem={false}
      >
        <ThemeSync />
        <LanguageSync windowId="main" />
        <FnosEntry />
        <button type="button" onClick={() => void run(pickFnosDirectory())}>
          Choose directory
        </button>
        <button
          type="button"
          onClick={() => void run(fnosFileAction('task-1', 'open'))}
        >
          Open file
        </button>
        <button
          type="button"
          onClick={() => void run(fnosFileAction('task-1', 'reveal'))}
        >
          Reveal folder
        </button>
        <button type="button" onClick={() => void run(fnosPlatformConfig())}>
          Read config
        </button>
        <output data-testid="result">{result}</output>
      </ThemeProvider>
    </PlatformServicesProvider>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(<App />)
