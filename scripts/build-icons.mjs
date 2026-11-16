import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Requires librsvg's rsvg-convert. On macOS: brew install librsvg.
const root = new URL('../', import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
mkdirSync(path('public/icon/'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const source = size <= 32 ? 'icon-small.svg' : 'icon.svg';
  const output = path(`public/icon/${size}.png`);
  execFileSync('rsvg-convert', [
    '--width',
    String(size),
    '--height',
    String(size),
    '--output',
    output,
    path(`assets/icon/${source}`),
  ]);
  const png = readFileSync(output);
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw Error(`Invalid icon size: ${output}`);
  console.log(`Rendered ${size}×${size} from ${source}`);
}
