import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'IPA packaging requires Xcode/macOS');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--app'), 'Pass --app /path/to/Release-iphoneos/Marinar.app');
const app = path.resolve(value('--app'));
const output = path.resolve(args.includes('--output') ? value('--output') : 'ios-app/build/release');
const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')], { encoding: 'utf8' }));
assert.equal(plist.CFBundleIdentifier, 'com.p16481012.marinar.ios.test');
assert.equal(plist.CFBundleExecutable, 'Marinar');
assert.ok(plist.CFBundleSupportedPlatforms.includes('iPhoneOS'), 'Cannot package a simulator app as IPA');
const architecture = execFileSync('lipo', ['-archs', path.join(app, 'Marinar')], { encoding: 'utf8' }).trim();
assert.equal(architecture, 'arm64');
const runtime = path.join(app, 'runtime');
const manifest = JSON.parse(await readFile(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of manifest.files) {
  assert.ok(!file.path.includes('..') && !path.isAbsolute(file.path));
  const bytes = await readFile(path.join(runtime, file.path));
  assert.equal(bytes.length, file.size, file.path);
  assert.equal(hash(bytes), file.sha256, file.path);
}
await mkdir(output, { recursive: true });
const staging = path.join(output, 'staging');
await rm(staging, { recursive: true, force: true });
await mkdir(path.join(staging, 'Payload'), { recursive: true });
await cp(app, path.join(staging, 'Payload/Marinar.app'), { recursive: true });
const filename = `Marinar-ios-test-${plist.CFBundleShortVersionString}-${plist.CFBundleVersion}-unsigned.ipa`;
const ipa = path.join(output, filename);
execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(staging, 'Payload'), ipa]);
const bytes = await readFile(ipa);
const metadata = {
  file: filename, version: plist.CFBundleShortVersionString, build: plist.CFBundleVersion,
  bundleIdentifier: plist.CFBundleIdentifier, platform: 'iPhoneOS', architecture,
  signedForInstallation: false, physicalDeviceValidated: false,
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  deploymentId: manifest.deploymentId, sha256: hash(bytes), bytes: bytes.length,
};
await writeFile(path.join(output, 'build-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${metadata.sha256}  ${filename}\n`);
await rm(staging, { recursive: true, force: true });
console.log(JSON.stringify(metadata, null, 2));
