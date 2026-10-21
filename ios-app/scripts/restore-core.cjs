// Shared by the bundled API and the pre-server native bootstrap. No dependencies.
// Archives contain secret material. Never log archive contents or encryption keys.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32 } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_STORAGE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 20000;
const FORMAT = 'marinar-ios-backup';
const ASSET_ROOTS = new Set(['avatars', 'sprites', 'avatar-models', 'backgrounds', 'gallery',
  'game-scene-videos', 'conversation-call-character-videos', 'fonts', 'knowledge-sources',
  'game-assets', 'custom-emojis', 'custom-stickers', 'notification-sounds', 'lorebooks',
  'prompts', 'agents', 'connections', 'long-term-memory']);
function assert(condition, message) { if (!condition) throw new Error(message); }
function relativePath(name) {
  assert(typeof name === 'string' && name.length > 0 && name.length <= 1024, 'Invalid backup path');
  assert(!/[\\\x00-\x1f:]/u.test(name) && !name.startsWith('/'), 'Unsafe backup path');
  assert(name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe backup path');
  return name;
}
function isDataPath(name) {
  relativePath(name);
  if (name === 'data/.encryption-key' || name === 'data/storage/manifest.json') return true;
  const parts = name.split('/');
  if (parts[0] !== 'data') return false;
  if (parts[1] === 'storage') return parts[2] === 'tables' && (parts.length === 4 || parts.length === 5)
    && parts.slice(3).every(part => !part.startsWith('.')) && name.endsWith('.json');
  return ASSET_ROOTS.has(parts[1]) && parts.length >= 3;
}
async function exists(name) { try { await fsp.lstat(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fsp.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp';
  const handle = await fsp.open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, filename);
  await syncDirectory(path.dirname(filename));
}
function locations(config) {
  assert(path.isAbsolute(config.dataDir) && path.isAbsolute(config.envFile), 'Absolute native paths are required');
  const root = path.join(path.dirname(config.envFile), 'ios-restore');
  assert(config.dataDir !== root && !config.dataDir.startsWith(root + path.sep)
    && !root.startsWith(config.dataDir + path.sep), 'Restore staging must be outside user data');
  return { root, stage: path.join(root, 'staged'), rollback: path.join(root, 'rollback'),
    journal: path.join(root, 'journal.json') };
}
async function readJournal(config) {
  const names = locations(config);
  if (!await exists(names.journal)) return { status: 'idle', restartRequired: false };
  const value = JSON.parse(await fsp.readFile(names.journal, 'utf8'));
  assert(['idle', 'staged', 'applying', 'applied', 'rolled-back', 'failed'].includes(value.status), 'Invalid restore journal');
  return value;
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of fs.createReadStream(filename)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
async function readExactly(handle, offset, size) {
  assert(Number.isSafeInteger(offset) && offset >= 0 && size >= 0 && size <= 8 * 1024 * 1024, 'Invalid ZIP record bounds');
  const buffer = Buffer.alloc(size); let read = 0;
  while (read < size) { const next = await handle.read(buffer, read, size - read, offset + read); assert(next.bytesRead > 0, 'Truncated ZIP'); read += next.bytesRead; }
  return buffer;
}

// The dedicated format uses ZIP32 stored entries only. Rejecting compression
// entirely avoids decompression bombs and keeps validation streaming on iOS.
async function readStoredZip(filename) {
  const size = (await fsp.stat(filename)).size;
  assert(size >= 22 && size <= MAX_BYTES, 'iOS backup ZIP must be at most 1 GiB');
  const handle = await fsp.open(filename, 'r');
  try {
    const end = await readExactly(handle, size - 22, 22);
    assert(end.readUInt32LE(0) === 0x06054b50 && end.readUInt16LE(20) === 0, 'Unsupported ZIP end record');
    const count = end.readUInt16LE(10), directorySize = end.readUInt32LE(12), directoryOffset = end.readUInt32LE(16);
    assert(end.readUInt16LE(4) === 0 && end.readUInt16LE(6) === 0 && end.readUInt16LE(8) === count, 'Split ZIP is not supported');
    assert(count > 0 && count <= MAX_FILES && directorySize <= 8 * 1024 * 1024
      && directoryOffset + directorySize === size - 22, 'Invalid ZIP directory');
    const directory = await readExactly(handle, directoryOffset, directorySize);
    const entries = []; const names = new Set(); let cursor = 0, total = 0;
    for (let index = 0; index < count; index++) {
      assert(cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === 0x02014b50, 'Damaged ZIP directory');
      const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16), compressed = directory.readUInt32LE(cursor + 20), bytes = directory.readUInt32LE(cursor + 24);
      const nameSize = directory.readUInt16LE(cursor + 28), extra = directory.readUInt16LE(cursor + 30), comment = directory.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameSize + extra + comment;
      assert(next <= directory.length && method === 0 && compressed === bytes && (flags & ~0x0808) === 0, 'Only unencrypted stored iOS backup ZIP entries are supported');
      assert(directory.readUInt16LE(cursor + 34) === 0 && ((directory.readUInt32LE(cursor + 38) >>> 16) & 0xf000) !== 0xa000, 'ZIP links and split entries are forbidden');
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameSize);
      const name = relativePath(nameBytes.toString('utf8'));
      assert(Buffer.from(name).equals(nameBytes) && !names.has(name) && !names.has(name.toLowerCase()), 'Duplicate or invalid ZIP filename');
      names.add(name); names.add(name.toLowerCase());
      assert(bytes <= MAX_FILE_BYTES && (total += bytes) <= MAX_BYTES, 'Backup contents exceed the supported size limit');
      const offset = directory.readUInt32LE(cursor + 42);
      assert(offset + 30 <= directoryOffset, 'Invalid ZIP local header offset');
      const header = await readExactly(handle, offset, 30);
      assert(header.readUInt32LE(0) === 0x04034b50 && header.readUInt16LE(6) === flags && header.readUInt16LE(8) === 0, 'ZIP local header disagrees');
      const localNameSize = header.readUInt16LE(26), localExtra = header.readUInt16LE(28);
      const localName = await readExactly(handle, offset + 30, localNameSize);
      assert(localName.equals(nameBytes), 'ZIP local filename disagrees');
      const start = offset + 30 + localNameSize + localExtra;
      let finish = start + bytes;
      assert(finish <= directoryOffset, 'ZIP entry exceeds its bounds');
      if (flags & 8) {
        const descriptor = await readExactly(handle, finish, 16);
        assert(descriptor.readUInt32LE(0) === 0x08074b50 && descriptor.readUInt32LE(4) === crc
          && descriptor.readUInt32LE(8) === bytes && descriptor.readUInt32LE(12) === bytes, 'ZIP descriptor disagrees');
        finish += 16;
      } else assert(header.readUInt32LE(14) === crc && header.readUInt32LE(18) === bytes && header.readUInt32LE(22) === bytes, 'ZIP local sizes disagree');
      entries.push({ name, size: bytes, crc32: crc, start, offset, finish }); cursor = next;
    }
    assert(cursor === directory.length, 'Unexpected ZIP directory tail');
    const ordered = [...entries].sort((a, b) => a.offset - b.offset);
    let position = 0;
    for (const entry of ordered) { assert(entry.offset === position, 'Overlapping or hidden ZIP content'); position = entry.finish; }
    assert(position === directoryOffset, 'Unexpected ZIP content before directory');
    return entries;
  } finally { await handle.close(); }
}
async function extractEntry(archive, entry, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let size = 0, checksum = 0; const hash = crypto.createHash('sha256');
  const inspect = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length; checksum = crc32(chunk, checksum); hash.update(chunk);
    callback(size > entry.size ? new Error('ZIP entry grew beyond its bound') : null, chunk);
  } });
  if (entry.size === 0) await fsp.writeFile(destination, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  else await pipeline(fs.createReadStream(archive, { start: entry.start, end: entry.start + entry.size - 1 }), inspect,
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  assert(size === entry.size && checksum === entry.crc32, 'ZIP file integrity check failed');
  const handle = await fsp.open(destination, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  return { size, sha256: hash.digest('hex') };
}
function validateManifest(value) {
  assert(value?.format === FORMAT && value.formatVersion === 1 && value.storageVersion === 7, 'Select a supported Marinar iOS full backup ZIP');
  assert(Array.isArray(value.files) && value.files.length > 0 && value.files.length < MAX_FILES, 'Invalid backup file manifest');
  let total = 0; const names = new Set();
  for (const item of value.files) {
    assert(isDataPath(item.path) && !names.has(item.path.toLowerCase()), 'Unexpected or duplicate backup path');
    names.add(item.path.toLowerCase());
    assert(Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= MAX_FILE_BYTES
      && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256), 'Invalid backup file record');
    assert(!item.path.startsWith('data/storage/') || item.size <= MAX_STORAGE_FILE_BYTES, 'A storage JSON file exceeds the iOS restore limit of 32 MiB');
    total += item.size; assert(total <= MAX_BYTES, 'Backup contents exceed 1 GiB');
  }
  assert(names.has('data/.encryption-key') && names.has('data/storage/manifest.json'), 'Backup lacks its storage or encryption key');
  return { files: value.files.length, bytes: total };
}
async function validateTree(stage, expectedManifestHash) {
  for (const directory of [stage, path.join(stage, 'data'), path.join(stage, 'data/storage')]) {
    assert((await fsp.lstat(directory)).isDirectory(), 'Staged backup directories must not be symlinks');
  }
  const manifestPath = path.join(stage, 'backup-manifest.json');
  const digest = await hashFile(manifestPath);
  if (expectedManifestHash) assert(digest.sha256 === expectedManifestHash, 'Staged backup manifest changed');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const summary = validateManifest(manifest);
  const expected = new Set(manifest.files.map(item => item.path));
  const actual = new Set();
  async function walk(directory, prefix) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/');
      else { assert(entry.isFile() && expected.has(name), 'Unexpected staged file or symlink'); actual.add(name); }
    }
  }
  await walk(path.join(stage, 'data'), 'data/');
  assert(actual.size === expected.size, 'Staged backup files are missing');
  for (const item of manifest.files) {
    const check = await hashFile(path.join(stage, ...item.path.split('/')));
    assert(check.size === item.size && check.sha256 === item.sha256, `Backup file checksum failed: ${item.path}`);
  }
  const key = (await fsp.readFile(path.join(stage, 'data/.encryption-key'), 'utf8')).trim();
  assert(/^[a-f0-9]{64}$/i.test(key), 'Backup encryption key is invalid');
  return { manifest, summary, manifestHash: digest.sha256, key };
}
async function rollback(config, journal) {
  const names = locations(config);
  // Each rename has a write-ahead phase. Recovery inspects source+destination,
  // so a kill immediately before/after a rename is safe and idempotent.
  for (const [label, target] of [['data', config.dataDir], ['env', config.envFile]]) {
    const previous = path.join(names.rollback, label);
    if (await exists(previous)) {
      if (await exists(target)) await fsp.rm(target, { recursive: label === 'data', force: true });
      await fsp.rename(previous, target);
      await syncDirectory(path.dirname(target));
    } else if (journal.phase !== 'moving-original' && journal[label === 'data' ? 'hadData' : 'hadEnv'] === false) {
      await fsp.rm(target, { recursive: label === 'data', force: true });
    }
  }
  await atomicJson(names.journal, { status: 'rolled-back', restartRequired: false, createdAt: journal.createdAt,
    message: 'The interrupted restore was rolled back. Your previous data was kept.' });
  await fsp.rm(names.stage, { recursive: true, force: true });
  await fsp.rm(names.rollback, { recursive: true, force: true });
}
async function applyPendingRestore(config) {
  const names = locations(config); const journal = await readJournal(config);
  for (const directory of [names.root, names.stage, names.rollback, config.dataDir]) {
    if (await exists(directory)) assert((await fsp.lstat(directory)).isDirectory(), 'Restore directories must not be symlinks');
  }
  if (await exists(config.envFile)) assert((await fsp.lstat(config.envFile)).isFile(), 'Environment path must not be a symlink');
  if (journal.status === 'applying') { await rollback(config, journal); return false; }
  if (journal.status === 'applied') {
    await fsp.rm(names.rollback, { recursive: true, force: true });
    await fsp.rm(names.stage, { recursive: true, force: true });
  }
  if (journal.status !== 'staged') return false;
  try {
    const checked = await validateTree(names.stage, journal.manifestHash);
    // Only the validated cryptographic setting is restored. Paths, session
    // tokens, install identity and runtime policy always come from native code.
    await fsp.writeFile(path.join(names.stage, 'env'), `ENCRYPTION_KEY=${checked.key}\n`, { mode: 0o600 });
    const envHandle = await fsp.open(path.join(names.stage, 'env'), 'r+');
    try { await envHandle.sync(); } finally { await envHandle.close(); }
  } catch (error) {
    await atomicJson(names.journal, { status: 'failed', restartRequired: false, createdAt: journal.createdAt,
      message: 'Staged backup validation failed. Your existing data was not changed.' });
    return false;
  }
  assert(!await exists(names.rollback), 'A previous restore recovery directory still exists');
  await fsp.mkdir(names.rollback, { recursive: true, mode: 0o700 });
  const applying = { ...journal, status: 'applying', phase: 'moving-original', hadData: await exists(config.dataDir), hadEnv: await exists(config.envFile) };
  await atomicJson(names.journal, applying);
  try {
    if (applying.hadData) await fsp.rename(config.dataDir, path.join(names.rollback, 'data'));
    if (applying.hadEnv) await fsp.rename(config.envFile, path.join(names.rollback, 'env'));
    await syncDirectory(names.rollback);
    await syncDirectory(path.dirname(config.dataDir));
    await syncDirectory(path.dirname(config.envFile));
    await atomicJson(names.journal, { ...applying, phase: 'installing' });
    await fsp.rename(path.join(names.stage, 'data'), config.dataDir);
    await fsp.rename(path.join(names.stage, 'env'), config.envFile);
    await syncDirectory(path.dirname(config.dataDir));
    await syncDirectory(path.dirname(config.envFile));
    return true;
  } catch (error) { await rollback(config, { ...applying, phase: 'installing' }); throw error; }
}
async function finishRestore(config) {
  const names = locations(config); const journal = await readJournal(config);
  if (journal.status !== 'applying') return;
  await atomicJson(names.journal, { status: 'applied', restartRequired: false, createdAt: journal.createdAt,
    message: 'Your full backup was restored, including saved API keys.' });
  // A completed journal is durable before removing recovery data. Interrupted
  // cleanup never causes a successful restore to roll back on the next launch.
  await fsp.rm(names.rollback, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(names.stage, { recursive: true, force: true }).catch(() => {});
}
module.exports = { MAX_BYTES, MAX_FILE_BYTES, MAX_FILES, FORMAT, ASSET_ROOTS, relativePath, isDataPath,
  locations, exists, hashFile, atomicJson, readJournal, readStoredZip, extractEntry, validateManifest,
  validateTree, applyPendingRestore, finishRestore, rollback };
