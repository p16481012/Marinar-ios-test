import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ios = fileURLToPath(new URL('../', import.meta.url));
const version = '24.22.0-0';
const filename = `nodejs-mobile-ios-${version}.zip`;
const url = `https://github.com/fogtape/nodejs-mobile/releases/download/v${version}/${filename}`;
const sha256 = 'f21ba80d2fa3d1fc313c48567576605209c07f41be66282ce7e0d687f2f42bd9';
const cache = path.join(ios, '.cache');
const vendor = path.join(ios, 'Vendor');
await mkdir(cache, { recursive: true });
await mkdir(vendor, { recursive: true });
const archive = path.join(cache, filename);
let bytes = await readFile(archive).catch(() => null);
const hash = data => createHash('sha256').update(data).digest('hex');
if (!bytes || hash(bytes) !== sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== sha256) throw new Error('Node framework checksum mismatch');
  await writeFile(archive, bytes);
}
if (process.platform !== 'darwin') throw new Error('Framework extraction and Xcode builds require macOS');
const extracted = path.join(cache, `unpacked-${version}`);
// Fixed generated path inside this project, separate from all user data.
await rm(extracted, { force: true, recursive: true });
await mkdir(extracted, { recursive: true });
execFileSync('ditto', ['-x', '-k', archive, extracted], { stdio: 'inherit' });
async function findFramework(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue;
    const candidate = path.join(directory, entry.name);
    if (entry.name === 'NodeMobile.xcframework') return candidate;
    const nested = await findFramework(candidate);
    if (nested) return nested;
  }
}
const framework = await findFramework(extracted);
if (!framework) throw new Error('Pinned archive does not contain NodeMobile.xcframework');
const destination = path.join(vendor, 'NodeMobile.xcframework');
await rm(destination, { force: true, recursive: true });
await cp(framework, destination, { recursive: true });
await writeFile(path.join(vendor, 'node-source.json'), JSON.stringify({ version, url, sha256,
  source: 'https://github.com/fogtape/nodejs-mobile/tree/v24.22.0-0',
  prerelease: true, variant: 'full',
}, null, 2) + '\n');
console.log(`Verified and extracted NodeMobile ${version} (${sha256})`);
