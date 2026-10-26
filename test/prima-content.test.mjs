import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrimaContent } from '../lib/prima-content.mjs';

const SHOW = 'https://www.iprima.cz/serialy/zradci';
const PROGRAM = 'verified-show-id';
const SEASON = 'verified-season-id';
const PREMIERE = '2031-10-25T19:15:00+00:00';
function nuxt(value) {
  const table = []; const objects = new WeakMap(); const scalars = new Map();
  function reference(value) {
    const key = `${typeof value}:${JSON.stringify(value)}`;
    if (value === null || typeof value !== 'object') {
      if (scalars.has(key)) return scalars.get(key);
      const index = table.length; scalars.set(key, index); table.push(value); return index;
    }
    if (objects.has(value)) return objects.get(value);
    const index = table.length; objects.set(value, index); table.push(null);
    table[index] = Array.isArray(value) ? value.map(reference) : Object.fromEntries(Object.entries(value).map(([key, value]) => [key, reference(value)]));
    return index;
  }
  reference(value);
  return `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(table)}</script>`;
}
function episode(number, changes = {}) {
  return { type: 'episode', title: `Zrádci S3 (${number})`, slug: `zradci/season-3/epizoda-${number}`,
    additionals: { programSlug: 'zradci', programId: PROGRAM, seasonId: SEASON, seasonNumber: 3, episodeNumber: number,
      isPromo: false, videoLength: 4400, premiereDateTime: PREMIERE, broadcastDateTime: '2031-10-25T18:15:00+00:00', ...changes } };
}
const urlFor = row => `https://www.iprima.cz/serialy/${row.slug}`;
function showHtml(episodes, { count = episodes.length, seasonCount = 3 } = {}) {
  return '<html>' + nuxt({
    series: { type: 'series', slug: 'zradci', id: PROGRAM, title: 'Zrádci ', additionals: { programSeasonsCount: seasonCount } },
    season: { id: SEASON, programId: PROGRAM, seasonNumber: 3, episodeCount: count, episodes },
    // A more recent recommendation must never become the selected show.
    recommendation: { ...episode(99, { programSlug: 'zradci-usa', programId: 'another-show' }), title: 'Zrádci USA S3 (99)' },
  }) + '</html>';
}
function episodeHtml(row, { publication = 'published', levels = ['light', 'premium'], seriesName = 'Zrádci' } = {}) {
  const url = urlFor(row);
  const content = { ...row, webUrl: url, publishingState: publication, distributions: [
    { autoplay: 'preview', showLock: true, error: null, userLevel: 'unregistered' },
    ...levels.map(userLevel => ({ autoplay: 'video', showLock: false, error: null, userLevel })),
  ] };
  const ld = { '@type': 'TVEpisode', url, name: row.title, episodeNumber: row.additionals.episodeNumber,
    partOfSeries: { '@type': 'TVSeries', name: seriesName }, datePublished: row.additionals.premiereDateTime };
  return '<html>' + nuxt({ content }) + `<script type="application/ld+json">${JSON.stringify(ld)}</script></html>`;
}
function fixture({ rows = [episode(6), episode(5)], showChanges, episodeChanges = {}, episodeBodies = {} } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = String(input); calls.push({ url, options });
    const row = rows.find(row => urlFor(row) === url);
    return new Response(url === SHOW ? showHtml(rows, showChanges) : episodeBodies[url] || (row ? episodeHtml(row, episodeChanges) : 'not found'), {
      status: url === SHOW || row ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  return { calls, fetchImpl };
}

test('resolves the latest published full catalog episode without playing or obtaining media', async () => {
  const f = fixture();
  const result = await resolvePrimaContent({ query: 'Zrádci', selection: 'latest' }, f);
  assert.equal(result.episode.season, 3); assert.equal(result.episode.number, 6);
  assert.equal(result.episode.durationSeconds, 4400);
  assert.equal(result.url, urlFor(episode(6)));
  assert.deepEqual(result.availability.fullVideoAccessLevels, ['light', 'premium']);
  assert.equal(result.availability.accountChecked, false);
  assert.equal(result.evidence.deepLinkVerified, false);
  assert.equal(result.evidence.playbackVerified, false);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.startsWith('https://www.iprima.cz/serialy/') && call.options.redirect === 'manual'));
});

test('future TV premiere is labeled honestly and is not confused with unpublished subscription content', async () => {
  const result = await resolvePrimaContent({ query: 'Zradci' }, fixture());
  assert.equal(result.episode.premiereDateTime, PREMIERE);
  assert.equal(result.availability.publishingState, 'published');
  assert.match(result.evidence.dateMeaning, /actual publication timestamp is not provided/);
});

test('skips promo, short clips and aftershow even when numbered above the full episode', async () => {
  const f = fixture({ rows: [episode(9, { isPromo: true }), episode(8, { videoLength: 120 }), episode(7, { programSlug: 'zradci-ze-zahrobi' }), episode(6), episode(5)] });
  const result = await resolvePrimaContent({ query: 'Zrádci' }, f);
  assert.equal(result.episode.number, 6);
  assert.equal(f.calls.length, 2);
});

test('incomplete season or missing latest-season coverage fails rather than guessing', async () => {
  for (const showChanges of [{ count: 30 }, { seasonCount: 4 }]) {
    const f = fixture({ showChanges });
    await assert.rejects(resolvePrimaContent({ query: 'Zrádci' }, f), error => error.code === 'catalog_incomplete');
    assert.equal(f.calls.length, 1);
  }
});

test('draft or preview-only latest entry is not selected as a published full episode', async () => {
  const six = episode(6); const five = episode(5);
  for (const changes of [{ publication: 'draft' }, { levels: [] }]) {
    const f = fixture({ rows: [six, five], episodeBodies: { [urlFor(six)]: episodeHtml(six, changes) } });
    const result = await resolvePrimaContent({ query: 'Zrádci' }, f);
    assert.equal(result.episode.number, 5);
    assert.equal(f.calls.length, 3);
  }
});

test('unknown query/selection, malicious slug and nonofficial redirect cannot trigger arbitrary fetches', async () => {
  const f = fixture();
  for (const input of [{ query: 'Zrádci USA' }, { query: 'https://evil.test' }, { query: 'Zrádci', selection: 'delete' }]) await assert.rejects(resolvePrimaContent(input, f));
  assert.equal(f.calls.length, 0);
  const bad = episode(6); bad.slug = 'zradci/season-3/epizoda-6?token=secret';
  const malicious = fixture({ rows: [bad] });
  await assert.rejects(resolvePrimaContent({ query: 'Zrádci' }, malicious), error => error.code === 'unsafe_url');
  assert.equal(malicious.calls.length, 1);
  let requests = 0;
  await assert.rejects(resolvePrimaContent({ query: 'Zrádci' }, { fetchImpl: async () => { requests++; return new Response('', { status: 302, headers: { Location: 'https://evil.test/serialy/zradci' } }); } }), error => error.code === 'unsafe_url');
  assert.equal(requests, 1);
});

test('episode identity disagreement and changed HTML fail closed', async () => {
  const f = fixture({ episodeChanges: { seriesName: 'Zrádci: Ze záhrobí' } });
  await assert.rejects(resolvePrimaContent({ query: 'Zrádci' }, f), error => error.code === 'episode_not_verified');
  await assert.rejects(resolvePrimaContent({ query: 'Zrádci' }, { fetchImpl: async () => new Response('<html>layout changed</html>', { headers: { 'Content-Type': 'text/html' } }) }), error => error.code === 'catalog_changed');
});
