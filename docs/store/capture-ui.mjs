import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The store art crops the shipped popup. Click the same controls used by a listener.
export async function captureStore({ browser, page, until, root }) {
  const extension = await browser.send('Extensions.loadUnpacked', { path: resolve(root, '.output/chrome-mv3') });
  const panel = await page(`chrome-extension://${extension.id}/panel.html`);
  await panel.send('Page.bringToFront');
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 400,
    height: 850,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await panel.evaluate("document.documentElement.classList.add('is-toolbar-popup')");
  const click = (selector) => panel.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(() => panel.evaluate("document.querySelector('[data-source=file]')?.disabled === false"), 'popup ready');
  await click('[data-source=file]');
  await until(
    () =>
      panel.evaluate(
        "document.querySelector('[data-source=file]').getAttribute('aria-pressed')==='true' && !document.querySelector('.ag-demo').disabled",
      ),
    'file source',
  );
  await click('.ag-demo');
  await until(
    () =>
      panel.evaluate(
        "document.querySelector('.ag-file-name').textContent.includes('A Foolish Game') && !document.querySelector('.ag-download').disabled",
      ),
    'demo loaded',
  );
  await panel.evaluate('document.fonts.ready.then(() => document.activeElement.blur())');
  const output = resolve(root, 'docs/store/ui');
  await mkdir(output, { recursive: true });
  async function shot(name, first, last) {
    await panel.evaluate('document.activeElement.blur()');
    await panel.evaluate(`document.querySelector(${JSON.stringify(last)}).scrollIntoView({block:'nearest'})`);
    const clip = await panel.evaluate(`(() => {
      const box = document.querySelector('.ag-product').getBoundingClientRect();
      const top = document.querySelector(${JSON.stringify(first)}).getBoundingClientRect().top;
      const bottom = document.querySelector(${JSON.stringify(last)}).getBoundingClientRect().bottom;
      const padding = ${name === 'presets' ? 0 : 8};
      const y = Math.max(box.top, top - padding);
      return {x:box.x, y, width:box.width, height:bottom + padding - y, scale:1};
    })()`);
    const png = await panel.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    await writeFile(resolve(output, name + '.png'), Buffer.from(png.data, 'base64'));
  }
  await shot('studio', '.ag-header', '.ag-file-export');
  await copyFile(resolve(output, 'studio.png'), resolve(root, 'site/assets/popup.png'));
  await shot('presets', '.ag-presets', '.ag-presets');
  await copyFile(resolve(output, 'presets.png'), resolve(root, 'site/welcome/presets.png'));
  await shot('tempo', '.ag-presets', '.ag-toggle-row');
  await click('[data-preset=dream]');
  await until(
    () => panel.evaluate("document.querySelector('[data-preset=dream]').getAttribute('aria-pressed')==='true'"),
    'Dream preset',
  );
  await shot('space', '.ag-presets', '.ag-compare');
  await click('.ag-export-options');
  await until(() => panel.evaluate("!document.querySelector('.ag-export-options-panel').hidden"), 'WAV settings');
  await shot('export', '.ag-compare', '.ag-export-options-panel');
  await click('.ag-settings');
  await until(() => panel.evaluate("!document.querySelector('#ag-settings-panel').hidden"), 'engine settings');
  await shot('engines', '.ag-header', '#ag-settings-panel');
}
