#!/usr/bin/env node
// Preserve original notices for bundled server modules and the installed client dependency graph.
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const noticeName = /^(?:licen[cs]es?|copying|notices?|copyright|ofl|unlicen[cs]e|patents|authors)(?:$|[._-])/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (value) => createHash('sha256').update(value).digest('hex');
// This exact published version links its license instead of shipping the text.
// Snapshot the linked publisher notice so offline builds retain the permission
// and copyright notice without depending on a mutable website during a build.
const linkedPublisherNotices = new Map([['abstract-logging@2.0.1', {
  source: 'https://jsumners.mit-license.org/', retrieved: '2026-10-21',
  text: `The MIT License (MIT)

Copyright © 2026 James Sumners <james.sumners@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`,
}]]);

function assertWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`License collection path leaves its allowed directory: ${candidate}`);
  }
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export async function collectLicenses() {
  const repo = await realpath(repositoryRoot);
  const runtime = path.join(repo, 'ios-app/Resources/runtime');
  await mkdir(runtime, { recursive: true });
  assertWithin(repo, await realpath(runtime));
  const destination = path.join(runtime, 'licenses');
  const manifest = JSON.parse(await readFile(path.join(repo, 'ios-app/build/server-metafile.json'), 'utf8'));
  if (!manifest.inputs || typeof manifest.inputs !== 'object') throw new Error('Server esbuild metadata has no inputs');
  const repositoryManifest = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  const packages = new Map();
  const rootCache = new Map();
  const traversed = new Set();

  async function packageAt(directory) {
    if (rootCache.has(directory)) return rootCache.get(directory);
    const candidate = path.join(directory, 'package.json');
    let result = null;
    if (await exists(candidate)) {
      const json = JSON.parse(await readFile(candidate, 'utf8'));
      if (json.name && json.version) result = { directory: await realpath(directory), json };
    }
    rootCache.set(directory, result);
    return result;
  }

  async function nearestPackage(input) {
    let current = path.dirname(input);
    while (true) {
      assertWithin(repo, current);
      const found = await packageAt(current);
      if (found) return found;
      if (current === repo) throw new Error(`No named npm package owns ${input}`);
      current = path.dirname(current);
    }
  }

  function addPackage(info, reason) {
    assertWithin(repo, info.directory);
    const key = `${info.json.name}@${info.json.version}`;
    let record = packages.get(key);
    if (!record) {
      record = { name: info.json.name, version: info.json.version, roots: new Map(), reasons: new Set() };
      packages.set(key, record);
    }
    record.roots.set(info.directory, info.json);
    record.reasons.add(reason);
  }

  for (const input of Object.keys(manifest.inputs).sort(compare)) {
    // Esbuild namespaces represent our explicit unavailable-feature stubs, not installed libraries.
    if (!input.replaceAll('\\', '/').includes('/node_modules/')) continue;
    const absolute = path.resolve(repo, input);
    assertWithin(repo, absolute);
    assertWithin(repo, await realpath(absolute));
    addPackage(await nearestPackage(absolute), 'server bundle');
  }

  async function resolveDependency(directory, name) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid dependency package name: ${name}`);
    let current = directory;
    while (true) {
      assertWithin(repo, current);
      const candidate = path.join(current, 'node_modules', ...name.split('/'));
      if (await exists(path.join(candidate, 'package.json'))) {
        const resolved = await realpath(candidate);
        assertWithin(repo, resolved);
        return packageAt(resolved);
      }
      if (current === repo) return null;
      current = path.dirname(current);
    }
  }

  async function visitClientPackage(info) {
    if (traversed.has(info.directory)) return;
    traversed.add(info.directory);
    // Workspaces share the repository's AGPL license; it is collected once below.
    if (info.directory.includes(`${path.sep}node_modules${path.sep}`)) addPackage(info, 'installed client dependency');
    const required = info.json.dependencies ?? {};
    const optional = info.json.optionalDependencies ?? {};
    const names = new Set([...Object.keys(required), ...Object.keys(optional), ...Object.keys(info.json.peerDependencies ?? {})]);
    for (const name of [...names].sort(compare)) {
      const dependency = await resolveDependency(info.directory, name);
      if (dependency) await visitClientPackage(dependency);
      else if (Object.hasOwn(required, name) && !Object.hasOwn(optional, name)) {
        throw new Error(`Required client dependency is not installed: ${info.json.name} -> ${name}`);
      }
    }
  }

  await visitClientPackage(await packageAt(path.join(repo, 'packages/client')));
  addPackage({ directory: repo, json: repositoryManifest }, 'Marinara application and shared source');

  async function noticeFiles(directory) {
    const result = [];
    async function walk(current, prefix) {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(current, entry.name);
        // Do not follow arbitrary package symlinks while preserving notices.
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile()) result.push({ relative, absolute });
        else if (entry.isDirectory()) await walk(absolute, relative);
      }
    }
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      if (!noticeName.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isFile()) result.push({ relative: entry.name, absolute });
      else if (entry.isDirectory()) await walk(absolute, entry.name);
    }
    return result;
  }

  // Fully read and validate source notices before replacing the generated destination.
  const records = [];
  for (const record of [...packages.values()].sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`))) {
    const files = new Map();
    const licenses = new Set();
    const metadata = [];
    let hasOriginalNotice = false;
    for (const [directory, json] of [...record.roots.entries()].sort(([a], [b]) => compare(a, b))) {
      const declared = json.license ?? json.licenses ?? 'Not declared in package.json';
      licenses.add(typeof declared === 'string' ? declared : JSON.stringify(declared));
      metadata.push({ name: json.name, version: json.version, license: declared, author: json.author, contributors: json.contributors, homepage: json.homepage, repository: json.repository });
      let notices = await noticeFiles(directory);
      hasOriginalNotice ||= notices.length > 0;
      if (notices.length === 0) {
        // Preserve the publisher's README verbatim when a separate notice is absent.
        notices = (await readdir(directory)).filter((name) => /^readme(?:$|[._-])/i.test(name)).sort(compare)
          .map((relative) => ({ relative, absolute: path.join(directory, relative) }));
      }
      for (const notice of notices) {
        assertWithin(directory, await realpath(notice.absolute));
        if (!(await lstat(notice.absolute)).isFile()) continue;
        const bytes = await readFile(notice.absolute);
        let relative = notice.relative;
        if (files.has(relative) && !files.get(relative).equals(bytes)) relative = `variant-${digest(bytes).slice(0, 12)}/${relative}`;
        files.set(relative, bytes);
      }
    }
    const linkedNotice = linkedPublisherNotices.get(`${record.name}@${record.version}`);
    if (!hasOriginalNotice && linkedNotice) {
      const bytes = Buffer.from(linkedNotice.text, 'utf8');
      files.set('LICENSE-publisher.txt', bytes);
      files.set('LICENSE-SOURCE.json', Buffer.from(JSON.stringify({
        source: linkedNotice.source, retrieved: linkedNotice.retrieved, sha256: digest(bytes),
      }, null, 2) + '\n'));
      hasOriginalNotice = true;
    }
    const folder = `${encodeURIComponent(record.name).replace(/^%40/, '@').replaceAll('%2F', '+')}-${encodeURIComponent(record.version)}`;
    records.push({ ...record, folder, files, licenses: [...licenses].sort(compare), metadata, hasOriginalNotice });
  }

  // This fixed, generated directory is never user data. Refuse a redirected destination.
  assertWithin(runtime, destination);
  if (await exists(destination)) {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('Refusing to replace a symlinked licenses directory');
    assertWithin(await realpath(runtime), await realpath(destination));
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const lines = [
    'Marinar iOS prototype — third-party notices',
    '',
    'Original license, copyright, and notice files are preserved under licenses/.',
    'Server packages are identified from the esbuild input graph.',
    'Client coverage conservatively includes the installed production dependency graph,',
    'including installed optional and peer dependencies; not every listed package is shipped.',
    'Marinara application and shared source are covered by the original root LICENSE.',
    'The embedded Node.js framework has a separate NodeMobile-LICENSE.txt notice.',
    '',
  ];
  const missing = [];
  for (const record of records) {
    const directory = path.join(destination, record.folder);
    assertWithin(destination, directory);
    await mkdir(directory, { recursive: true });
    const uniqueMetadata = [...new Map(record.metadata.map((value) => [JSON.stringify(value), value])).values()];
    await writeFile(path.join(directory, 'PACKAGE-METADATA.json'), JSON.stringify(uniqueMetadata.length === 1 ? uniqueMetadata[0] : uniqueMetadata, null, 2) + '\n');
    for (const [relative, bytes] of [...record.files.entries()].sort(([a], [b]) => compare(a, b))) {
      const output = path.resolve(directory, relative);
      assertWithin(directory, output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    lines.push(`${record.name}@${record.version}`, `  Declared license: ${record.licenses.join(' | ')}`,
      `  Coverage: ${[...record.reasons].sort(compare).join(', ')}`, `  Original files: licenses/${record.folder}/`);
    if (!record.hasOriginalNotice) {
      lines.push('  Publisher includes no standalone license/notice file; package metadata and any README are preserved.');
      missing.push(`${record.name}@${record.version}`);
    }
    lines.push('');
  }
  for (const filename of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
    const output = path.join(runtime, filename);
    if (await exists(output)) {
      if ((await lstat(output)).isSymbolicLink()) throw new Error(`Refusing to overwrite a symlinked runtime notice: ${filename}`);
      assertWithin(await realpath(runtime), await realpath(output));
    }
  }
  await cp(path.join(repo, 'LICENSE'), path.join(runtime, 'LICENSE'));
  await writeFile(path.join(runtime, 'THIRD-PARTY-NOTICES.txt'), lines.join('\n') + '\n');
  console.log(`Collected original notices for ${records.length} packages (${missing.length} without standalone notice files).`);
  if (missing.length) console.log(`No standalone publisher notice: ${missing.join(', ')}`);
  return { packages: records.length, missingStandaloneNotices: missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await collectLicenses();
