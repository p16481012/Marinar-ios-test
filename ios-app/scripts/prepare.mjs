import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLicenses } from './collect-licenses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = path.dirname(root.replace(/[\\/]$/, ''));
const runtime = path.join(root, 'Resources/runtime');
const serverOnly = process.argv.includes('--server-only');
await mkdir(runtime, { recursive: true });

// The first prototype does not execute desktop subprocesses, native image/ML
// modules, or a second JS VM. Preserve explicit errors if a caller reaches one.
const unavailable = /^(?:@anthropic-ai\/claude-agent-sdk|@earendil-works\/(?:pi-coding-agent|pi-ai)|@huggingface\/transformers|@img\/sharp-wasm32|sharp|onnxruntime-node|onnxruntime-web|quickjs-emscripten|pdf-parse)(?:\/.*)?$/;
const result = await build({
  absWorkingDir: repo,
  entryPoints: ['packages/server/src/ios.ts'],
  outfile: path.join(runtime, 'server.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  sourcemap: false, minify: false, metafile: true, logLevel: 'info',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __dirnameOf } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);" },
  plugins: [{ name: 'ios-unavailable-desktop-modules', setup(builder) {
    builder.onResolve({ filter: unavailable }, args => ({ path: args.path, namespace: 'ios-unavailable' }));
    builder.onLoad({ filter: /.*/, namespace: 'ios-unavailable' }, args => ({
      loader: 'js', contents: `throw Object.assign(new Error(${JSON.stringify(`${args.path} is not available in this iOS prototype`)}), {code:'IOS_FEATURE_UNAVAILABLE'}); module.exports = {};`,
    }));
  } }],
});
await cp(path.join(root, 'scripts/bootstrap.cjs'), path.join(runtime, 'bootstrap.cjs'));
await cp(path.join(repo, 'packages/server/src/db/default-preset.json'), path.join(runtime, 'default-preset.json'));
// Assets are generated under this fixed runtime path; drop upstream removals too.
const assetDestination = path.resolve(runtime, 'assets');
if (path.relative(runtime, assetDestination) !== 'assets') throw new Error('Invalid generated asset path');
await rm(assetDestination, { recursive: true, force: true });
await cp(path.join(repo, 'packages/server/src/assets'), path.join(runtime, 'assets'), { recursive: true });
await cp(path.join(repo, 'LICENSE'), path.join(runtime, 'LICENSE'));
await cp(path.join(root, 'third-party/NodeMobile-LICENSE.txt'), path.join(runtime, 'NodeMobile-LICENSE.txt'));
await writeFile(path.join(runtime, 'SOURCE.json'), JSON.stringify({
  upstream: 'https://github.com/Pasta-Devs/Marinara-Engine',
  revision: '8042ef6ec638801de45b8d82f82cd2dea85f51a4',
  fork: 'https://github.com/p16481012/Marinar-ios-test',
  nodeMobile: {
    source: 'https://github.com/fogtape/nodejs-mobile',
    revision: '9e1a7dc7510a336392448a827f64672b68e69ce0',
    version: '24.22.0-0',
    archiveSha256: 'f21ba80d2fa3d1fc313c48567576605209c07f41be66282ce7e0d687f2f42bd9',
  },
}, null, 2) + '\n');
await mkdir(path.join(root, 'build'), { recursive: true });
await writeFile(path.join(root, 'build/server-metafile.json'), JSON.stringify(result.metafile));
await collectLicenses();
if (serverOnly) {
  console.log('Server bundle prepared. Build the client and run without --server-only for an app runtime.');
  process.exit(0);
}
const client = path.join(repo, 'packages/client/dist');
await stat(path.join(client, 'index.html'));
// This generated destination is fixed inside ios-app/Resources; never user data.
await rm(path.join(runtime, 'client'), { recursive: true, force: true });
await cp(client, path.join(runtime, 'client'), { recursive: true });
const paths = [];
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/');
    else if (entry.isFile() && name !== 'runtime-manifest.json') paths.push(name);
    else if (!entry.isFile()) throw new Error(`Unsupported runtime entry: ${name}`);
  }
}
await walk(runtime);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const relative of paths.sort()) {
  const bytes = await readFile(path.join(runtime, relative));
  files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
}
const version = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
const deploymentId = hash(files.map(file => `${file.path}\t${file.sha256}\t${file.size}\n`).join(''));
await writeFile(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ formatVersion: 1, version, deploymentId, files }, null, 2) + '\n');
console.log(`Prepared ${files.length} runtime files (${deploymentId})`);
