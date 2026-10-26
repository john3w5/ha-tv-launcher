import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../ha-app/prepare-package.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const committed = path.join(root, 'addon');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'home-tv-package-check-')));
const hash = value => createHash('sha256').update(value).digest('hex');
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'Package must not contain symbolic links');
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), name));
    else { assert(entry.isFile()); result.push(name); }
  }
  return result.sort();
}
try {
  const expected = await prepare(path.join(temporary, 'expected'));
  const manifest = JSON.parse(await readFile(path.join(committed, 'package-manifest.json'), 'utf8'));
  assert.equal(manifest.privateDataIncluded, false);
  assert.deepEqual(manifest.files, expected.files, 'Regenerate addon/ after changing runtime or HA packaging');
  assert.deepEqual(await files(committed), [...expected.files.map(file => file.path), 'package-manifest.json'].sort(),
    'Committed package contains unexpected or missing files');
  for (const file of expected.files) {
    const filename = path.join(committed, file.path);
    assert((await lstat(filename)).isFile());
    const bytes = await readFile(filename);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(hash(bytes), file.sha256, file.path);
  }
  console.log(`HA package parity PASS: ${expected.files.length} payload files`);
} finally { await rm(temporary, { recursive: true, force: true }); }
