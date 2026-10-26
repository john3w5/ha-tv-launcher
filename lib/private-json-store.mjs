import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const failure = () => new Error('Soukromá data aplikace nelze bezpečně načíst nebo uložit.');

/** Small atomic private state files. No links, public permissions or partial writes. */
export async function createPrivateJsonStore(filename, { maxBytes = 1024 * 1024 } = {}) {
  if (!filename) return { persistent: false, read: async () => null, write: async () => {} };
  filename = path.resolve(filename);
  const parent = path.dirname(filename);
  let current = path.parse(parent).root;
  for (const part of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw failure(); });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
  }
  const directory = await lstat(parent);
  if ((directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw failure();
  const check = info => {
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes || (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())) throw failure();
  };
  const existing = async () => {
    try { const info = await lstat(filename); if (info.isSymbolicLink()) throw failure(); check(info); }
    catch (error) { if (error.code !== 'ENOENT') throw failure(); }
  };
  return {
    persistent: true,
    async read() {
      let handle;
      try {
        handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); check(await handle.stat());
        const raw = await handle.readFile('utf8');
        try { return JSON.parse(raw); }
        catch { throw Object.assign(failure(), { code: 'TV_STATE_INVALID' }); }
      } catch (error) { if (error.code === 'ENOENT') return null; if (error.code === 'TV_STATE_INVALID') throw error; throw failure(); }
      finally { await handle?.close(); }
    },
    async write(data) {
      const raw = JSON.stringify(data) + '\n'; if (Buffer.byteLength(raw) > maxBytes) throw failure();
      await existing();
      const temporary = path.join(parent, `.tv-state-${randomBytes(12).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
        await rename(temporary, filename);
      } catch { throw failure(); }
      finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw failure(); }); }
    },
  };
}
