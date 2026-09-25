import { settings, updateSettings } from '../state/settings'
import { tab } from '../state/store'
import { installPrompt, isAppleMobile, isInstalled, promptInstall } from './install'

/**
 * Offers to install the page, once. Installed, it opens like an app and can
 * show notifications on a phone.
 */
export function InstallBanner() {
  if (isInstalled() || settings.value.installDismissed) return null
  const canPrompt = installPrompt.value !== null
  const apple = isAppleMobile()
  if (!canPrompt && !apple) return null

  return (
    <div class="banner install">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="M7 10l5 5 5-5" />
        <path d="M4 21h16" />
      </svg>
      <span>
        {apple && !canPrompt
          ? 'Add to your Home Screen for an app icon and notifications when a slot frees: Share, then Add to Home Screen.'
          : 'Install for an app icon and notifications when a slot frees.'}
      </span>
      <div class="banner-actions">
        {canPrompt ? (
          <button class="primary" onClick={() => void promptInstall()}>
            Install
          </button>
        ) : (
          <button class="link" onClick={() => (tab.value = 'alerts')}>
            Alerts
          </button>
        )}
        <button class="link" onClick={() => updateSettings({ installDismissed: true })}>
          dismiss
        </button>
      </div>
    </div>
  )
}
