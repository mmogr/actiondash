import { render } from 'preact'
import './styles.css'
import { App } from './app'
import { listenForShowRun, registerServiceWorker, watchForAlerts } from './notify'
import { watchInstallPrompt } from './ui/install'
import { watchRoute } from './ui/route'
import { watchTitle } from './ui/title'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app mount point')

watchInstallPrompt()
registerServiceWorker()
listenForShowRun()
watchForAlerts()
watchRoute()
watchTitle()
render(<App />, root)
