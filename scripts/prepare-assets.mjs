import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
const root = new URL('../', import.meta.url);
const assets = JSON.parse(await readFile(new URL('./bundled-assets.json', import.meta.url), 'utf8'));
for (const [path, entry] of Object.entries(assets)) {
  if (!/^src\/(fonts|photos)\/[A-Za-z0-9_.-]+\.(woff2|png)$/.test(path)) throw Error('Invalid bundled asset path');
  const bytes = Buffer.from(entry.base64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('Bundled asset failed integrity check');
  const target = new URL(path, root);
  await mkdir(dirname(target.pathname), { recursive: true });
  await writeFile(target, bytes);
}
console.log('Prepared verified bundled fonts and neutral icons.');
