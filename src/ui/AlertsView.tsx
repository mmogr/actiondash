import { useEffect, useState } from 'preact/hooks'
import type { AlertPrefs } from '../model/alerts'
import { notificationPermission, requestPermission, type Permission } from '../notify'
import { settings, updateSettings } from '../state/settings'
import { isAppleMobile, isInstalled } from './install'

const HOME_SCREEN =
  'On iPhone and iPad, notifications only work once the page is added to the Home Screen. Use Share, then Add to Home Screen.'

const CHOICES: { key: keyof AlertPrefs; label: string; detail: string }[] = [
  {
    key: 'slotFreed',
    label: 'A slot frees',
    detail: 'The pool was full, a job finished, and something is waiting for the slot.',
  },
  {
    key: 'jobStarted',
    label: 'A queued job starts',
    detail: 'A job that was waiting has taken a slot.',
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
    setPermission(await requestPermission())
    setAsking(false)
  }

  function toggle(key: keyof AlertPrefs) {
    updateSettings({ alerts: { ...prefs, [key]: !prefs[key] } })
  }

  const enabled = permission === 'granted'

  return (
    <div class="settings">
      <div class="card">
        <h2>Alerts</h2>
        <p>
          Alerts arrive while actiondash is open. There is no server behind this page, so nothing
          can wake it in the background; keep it open, or installed and in the foreground, while
          you wait on a slot.
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
          <div class="hint good">Notifications are allowed.</div>
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
        <h2>Tell me when</h2>
        <div class="toggles">
          {CHOICES.map((c) => (
            <label class={`toggle${enabled ? '' : ' off'}`} key={c.key}>
              <input
                type="checkbox"
                checked={prefs[c.key]}
                disabled={!enabled}
                onChange={() => toggle(c.key)}
              />
              <span class="toggle-text">
                <span class="toggle-label">{c.label}</span>
                <span class="toggle-detail">{c.detail}</span>
              </span>
            </label>
          ))}
        </div>
        {!enabled && permission !== 'unsupported' && (
          <div class="hint">Allow notifications above to turn these on.</div>
        )}
      </div>
    </div>
  )
}
