import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { DEV_CSP, PROD_CSP } from './src/csp.ts'

/**
 * Injects the Content Security Policy and referrer policy as the first two
 * elements of <head>. A meta CSP only governs content that appears after it, so
 * head-prepend is required rather than cosmetic.
 */
function cspPlugin(): Plugin {
  return {
    name: 'actiondash-csp',
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? DEV_CSP : PROD_CSP
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
            injectTo: 'head-prepend',
          },
          {
            tag: 'meta',
            attrs: { name: 'referrer', content: 'no-referrer' },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/actiondash/
  base: './',
  plugins: [preact(), cspPlugin()],
  build: {
    target: 'es2022',
    // Keep every asset external so the strict script-src/style-src hold.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
  },
})
