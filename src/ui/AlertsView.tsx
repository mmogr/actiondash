import { useEffect, useState } from 'preact/hooks'
import type { AlertPrefs } from '../model/alerts'
import {
  notificationPermission,
  requestPermission,
  sendTestNotification,
  type Permission,
} from '../notify'
import { settings, updateSettings } from '../state/settings'
import { isAppleMobile, isInstalled } from './install'

const HOME_SCREEN =
  'On iPhone and iPad, notifications only work once the page is added to the Home Screen. Use Share, then Add to Home Screen.'

interface Choice {
  key: keyof AlertPrefs
  label: string
  detail: string
}

const YOURS: Choice[] = [
  {
    key: 'myStarted',
    label: 'My run starts',
    detail: 'One of your runs takes its first slot.',
  },
  {
    key: 'myFinished',
    label: 'My run finishes',
    detail: 'One of your runs leaves the queue, with any job that failed named.',
  },
]

const EVERYONE: Choice[] = [
  {
    key: 'slotFreed',
    label: 'A slot frees',
    detail: 'The pool was full, a job finished, and something is waiting for the slot.',
  },
  {
    key: 'jobStarted',
    label: 'A queued job starts',
    detail: "Any job that was waiting takes a slot, whoever's it is.",
  },
  {
    key: 'superseded',
    label: 'A run is superseded',
    detail: 'A newer commit on the same branch has made a run pointless while it holds or waits for a slot.',
  },
]

export function AlertsView() {
  const [permission, setPermission] = useState<Permission>(notificationPermission())
  const [asking, setAsking] = useState(false)
  const prefs = settings.value.alerts
  const login = settings.value.login
  // iOS offers notifications only to a Home Screen app, so a Safari tab
  // reports them as unsupported when the real answer is "install it first".
  const needsHomeScreen = isAppleMobile() && !isInstalled()

  // Permission can change in the browser's own settings while the page is away.
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === 'visible') setPermission(notificationPermission())
    }
    reread()
    document.addEventListener('visibilitychange', reread)
    return () => document.removeEventListener('visibilitychange', reread)
  }, [])

  async function ask() {
    setAsking(true)
    const answer = await requestPermission()
    setPermission(answer)
    setAsking(false)
    // Allowing notifications is the moment the reader asked for alerts, so the
    // two about their own runs start on. Nothing turns on behind their back.
    const current = settings.value.alerts
    if (answer === 'granted' && login && !Object.values(current).some(Boolean)) {
      updateSettings({ alerts: { ...current, myStarted: true, myFinished: true } })
    }
  }

  function toggle(key: keyof AlertPrefs) {
    updateSettings({ alerts: { ...prefs, [key]: !prefs[key] } })
  }

  const enabled = permission === 'granted'

  const toggles = (choices: Choice[], available: boolean) => (
    <div class="toggles">
      {choices.map((c) => (
        <label class={`toggle${available ? '' : ' off'}`} key={c.key}>
          <input
            type="checkbox"
            checked={prefs[c.key]}
            disabled={!available}
            onChange={() => toggle(c.key)}
          />
          <span class="toggle-text">
            <span class="toggle-label">{c.label}</span>
            <span class="toggle-detail">{c.detail}</span>
          </span>
        </label>
      ))}
    </div>
  )

  return (
    <div class="settings">
      <div class="card">
        <h2>Alerts</h2>
        <p>
          Alerts arrive while actiondash is open. There is no server behind this page, so nothing
          can wake it in the background; keep it open, or installed and in the foreground, while
          you wait on a slot. In a background tab, the browser may hold one back for up to a
          minute. Tapping an alert opens the run it is about.
        </p>
        {permission === 'unsupported' ? (
          needsHomeScreen ? (
            <div class="hint">{HOME_SCREEN}</div>
          ) : (
            <div class="hint bad">This browser does not offer notifications to web pages.</div>
          )
        ) : permission === 'denied' ? (
          <div class="hint bad">
            Notifications are blocked for this site. Allow them in the browser's site settings to
            turn alerts on.
          </div>
        ) : permission === 'granted' ? (
          <div class="field-row">
            <span class="hint good">Notifications are allowed.</span>
            <button onClick={sendTestNotification}>Send a test notification</button>
          </div>
        ) : (
          <div class="field-row">
            <button class="primary" onClick={() => void ask()} disabled={asking}>
              {asking ? 'Asking…' : 'Allow notifications'}
            </button>
          </div>
        )}
        {needsHomeScreen && permission !== 'unsupported' && <div class="hint">{HOME_SCREEN}</div>}
      </div>

      <div class="card">
        <h2>Your runs</h2>
        {toggles(YOURS, enabled && login !== null)}
        {enabled && login === null && (
          <div class="hint">
            These need to know which runs are yours, which the dashboard learns from GitHub on its
            next check.
          </div>
        )}
      </div>

      <div class="card">
        <h2>Everyone</h2>
        {toggles(EVERYONE, enabled)}
        {!enabled && permission !== 'unsupported' && (
          <div class="hint">Allow notifications above to turn these on.</div>
        )}
      </div>
    </div>
  )
}
