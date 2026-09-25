import { signal } from '@preact/signals'

/**
 * Installing to the home screen. Chromium fires beforeinstallprompt and lets
 * the page trigger the prompt; Safari has no event and needs the Share menu.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
}

/** The deferred prompt, when the browser offered one. */
export const installPrompt = signal<InstallPromptEvent | null>(null)

export function isInstalled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(display-mode: standalone)').matches
}

/** True on an iPhone or iPad, where installing is a Share menu action. */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

export function watchInstallPrompt(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt.value = e as InstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    installPrompt.value = null
  })
}

export async function promptInstall(): Promise<void> {
  const prompt = installPrompt.value
  if (!prompt) return
  installPrompt.value = null
  try {
    await prompt.prompt()
  } catch {
    // The browser declined to show it. The Share menu route still works.
  }
}
