import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FILES = ['server.mjs', 'package.json', 'config.example.json', 'assistant-plan.schema.json'];
// The source template is deliberately not named config.yaml: Supervisor must
// discover only the generated addon/ app, not this authoring directory.
const PACKAGING = ['Dockerfile', '.dockerignore', 'startup.mjs', 'README.md', 'translations/cs.yaml']
  .map(name => ({ from: name, to: name })).concat({ from: 'app-config.yaml', to: 'config.yaml' });
const rejected = name => name.startsWith('.') || name.endsWith('.test.mjs') || name === 'node_modules';

async function collect(directory, prefix = '') {
  const selected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (rejected(entry.name)) continue;
    const relative = path.join(prefix, entry.name), filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('A package source must not be a symbolic link.');
    if (entry.isDirectory()) selected.push(...await collect(filename, relative));
    else if (entry.isFile()) selected.push(relative);
    else throw new Error('Unexpected package source type.');
  }
  return selected.sort();
}

export async function prepare(destination, { source = REPO } = {}) {
  destination = path.resolve(destination);
  // Build only into a fresh directory. Never replace source, runtime, or personal data.
  if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Package destination already exists.');
  let current = path.dirname(destination);
  while (true) {
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error('Package destination has an unsafe parent.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const files = [...FILES.map(name => ({ from: path.join(source, name), to: path.join('runtime', name) }))];
  for (const tree of ['public', 'lib']) {
    const info = await lstat(path.join(source, tree));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe runtime source directory.');
    for (const file of await collect(path.join(source, tree))) files.push({ from: path.join(source, tree, file), to: path.join('runtime', tree, file) });
  }
  for (const file of PACKAGING) files.push({ from: path.join(HERE, file.from), to: file.to });
  const entries = [];
  for (const file of files) {
    const info = await lstat(file.from);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Invalid runtime source file.');
    const data = await readFile(file.from);
    entries.push({ ...file, data, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  if (entries.length > 500 || entries.reduce((sum, file) => sum + file.bytes, 0) > 25 * 1024 * 1024) throw new Error('Unexpected package size.');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of entries) {
    const target = path.join(destination, file.to);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: 0o600, flag: 'wx' });
  }
  const manifest = { version: 1, generatedAt: new Date().toISOString(), privateDataIncluded: false,
    files: entries.map(({ to, bytes, sha256 }) => ({ path: to, bytes, sha256 })) };
  await writeFile(path.join(destination, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node ha-app/prepare-package.mjs /absolute/new/package-directory');
  const manifest = await prepare(process.argv[2]);
  console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), privateDataIncluded: false }));
}
