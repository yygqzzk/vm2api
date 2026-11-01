import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { SlotBrowserButton } from '@/features/vm/slot-browser-panel'
import { setSession } from '@/lib/session'
import '@/styles/index.css'

const fixture = JSON.parse(document.querySelector('#fixture-data')!.textContent!)
setSession('kin-panel-offline-acceptance', 'acceptance')
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Preview() {
  const [complete, setComplete] = useState(false)
  return <QueryClientProvider client={client}>
    <main style={{ padding: 24 }}>
      <h1>Offline slot browser acceptance</h1>
      <SlotBrowserButton vm={fixture.vm} authUrl={fixture.authUrl}
        codexSessionId={fixture.codexSessionId} onAuthorized={() => setComplete(true)} />
      {complete ? <p role='status'>Acceptance OAuth imported</p> : null}
    </main>
    <Toaster />
  </QueryClientProvider>
}

createRoot(document.querySelector('#root')!).render(<Preview />)
