import { useEffect } from 'preact/hooks'
import { now, view } from './state/store'
import { Setup } from './ui/Setup'
import { Dashboard } from './ui/Dashboard'

export function App() {
  // A one-second tick so relative ages advance between polls.
  useEffect(() => {
    const id = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return view.value === 'setup' ? <Setup /> : <Dashboard />
}
