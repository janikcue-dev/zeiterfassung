import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Büro-Bereich nur unter /?buero – wird separat nachgeladen,
// damit die Mitarbeiter-App auf dem Handy nicht größer wird.
const BueroApp = lazy(() => import('./buero/BueroApp.jsx'))
const istBuero = new URLSearchParams(window.location.search).has('buero')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {istBuero ? (
      <Suspense fallback={null}>
        <BueroApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
