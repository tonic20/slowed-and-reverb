import { defineConfig } from 'wxt';
export default defineConfig({
  imports: false,
  manifestVersion: 3,
  dev: { server: { host: '127.0.0.1', origin: '127.0.0.1' } },
  zip: { excludeSources: ['docs/**', 'tests/**', 'site/**'] },
  manifest: {
    name: '__MSG_appName__',
    description: '__MSG_shortDesc__',
    default_locale: 'en',
    homepage_url: 'https://slowedandreverb.online/',
    externally_connectable: { matches: ['https://slowedandreverb.online/*'] },
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'storage', 'tabCapture', 'offscreen', 'downloads'],
    action: {
      default_title: '__MSG_appName__',
      default_popup: 'panel.html',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    },
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'; media-src 'self' blob:",
    },
  },
});
