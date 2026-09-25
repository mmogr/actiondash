import { render } from 'preact'
import './styles.css'
import { App } from './app'
import { registerServiceWorker, watchForAlerts } from './notify'
import { watchInstallPrompt } from './ui/install'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app mount point')

watchInstallPrompt()
registerServiceWorker()
watchForAlerts()
render(<App />, root)
