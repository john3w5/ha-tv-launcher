// Read-only resolver of public official catalog HTML. Does not obtain media,
// authenticate, invoke the TV, or bypass a subscription/DRM check.
const SHOW_URL = 'https://www.iprima.cz/serialy/zradci';
const HOSTS = new Set(['www.iprima.cz', 'iprima.cz']);
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export class PrimaContentError extends Error {
  constructor(code, message) { super(message); this.name = 'PrimaContentError'; this.code = code; }
}
function fail(code, message) { throw new PrimaContentError(code, message); }
function catalogUrl(input) {
  let url;
  try { url = new URL(input); } catch { fail('unsafe_url', 'Neplatná adresa pořadu.'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/serialy\/zradci(?:\/[a-z0-9-]+\/[a-z0-9-]+)?$/.test(url.pathname)) fail('unsafe_url', 'Adresa není povolenou oficiální stránkou Zrádců.');
  return url;
}
async function htmlPage(url, fetchImpl, redirects = 0) {
  const safe = catalogUrl(url);
  let response;
  try { response = await fetchImpl(safe, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Accept: 'text/html' } }); }
  catch { fail('catalog_unavailable', 'Oficiální katalog prima+ není dostupný.'); }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 2 || !response.headers.get('location')) fail('unsafe_redirect', 'Katalog vrátil nepodporované přesměrování.');
    const target = catalogUrl(new URL(response.headers.get('location'), safe));
    if (target.pathname !== safe.pathname) fail('unsafe_redirect', 'Katalog přesměroval na jiný pořad nebo přihlášení.');
    return htmlPage(target, fetchImpl, redirects + 1);
  }
  if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('catalog_unavailable', 'Oficiální stránka nevrátila očekávaný katalog.');
  if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) fail('catalog_too_large', 'Katalog překročil bezpečný limit.');
  if (!response.body) fail('catalog_unavailable', 'Oficiální katalog je prázdný.');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > MAX_HTML_BYTES) { await reader.cancel(); fail('catalog_too_large', 'Katalog překročil bezpečný limit.'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
function tableOf(html) {
  const match = /<script\b[^>]*\bid=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  if (!match) fail('catalog_changed', 'Struktura oficiálního katalogu se změnila.');
  let table;
  try { table = JSON.parse(match[1]); } catch { fail('catalog_changed', 'Data oficiálního katalogu nelze bezpečně přečíst.'); }
  if (!Array.isArray(table) || table.length > 50000) fail('catalog_changed', 'Data katalogu mají nepodporovaný formát.');
  return table;
}
function field(table, node, key) {
  const reference = plain(node) ? node[key] : undefined;
  return Number.isInteger(reference) && reference >= 0 && reference < table.length ? table[reference] : undefined;
}
function rows(table) { return table.filter(plain); }
function positive(value) { return Number.isInteger(value) && value > 0 && value < 10000; }
function iso(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; }
function fullEpisode(table, row, programId) {
  const extra = field(table, row, 'additionals');
  const season = field(table, extra, 'seasonNumber'); const number = field(table, extra, 'episodeNumber');
  const duration = field(table, extra, 'videoLength'); const slug = field(table, row, 'slug');
  const title = field(table, row, 'title');
  if (field(table, row, 'type') !== 'episode' || field(table, extra, 'programSlug') !== 'zradci' || field(table, extra, 'programId') !== programId || field(table, extra, 'isPromo') !== false || !positive(season) || !positive(number) || !Number.isFinite(duration) || duration < 1800 || duration > 10800 || typeof slug !== 'string' || typeof title !== 'string') return null;
  // Exact show, full episode metadata and a numbered title exclude trailers,
  // aftershows and short bonus clips even if they appear in recommendations.
  const numbered = /^Zrádci\s+S(\d+)\s+\((\d+)\)\s*$/iu.exec(title);
  if (!numbered || Number(numbered[1]) !== season || Number(numbered[2]) !== number) return null;
  const url = catalogUrl(new URL(`/serialy/${slug}`, SHOW_URL)).href;
  return { url, title: title.trim(), season, number, durationSeconds: duration,
    premiereDateTime: iso(field(table, extra, 'premiereDateTime')), broadcastDateTime: iso(field(table, extra, 'broadcastDateTime')),
    seasonId: field(table, extra, 'seasonId') };
}
function candidatesFromShow(html) {
  const table = tableOf(html);
  const showRows = rows(table).filter(row => field(table, row, 'type') === 'series' && field(table, row, 'slug') === 'zradci' && typeof field(table, row, 'title') === 'string' && normalized(field(table, row, 'title')) === 'zradci');
  const programIds = new Set(showRows.map(row => field(table, row, 'id')));
  if (programIds.size !== 1 || typeof [...programIds][0] !== 'string') fail('show_not_verified', 'Nepodařilo se jednoznačně ověřit hlavní pořad Zrádci.');
  const programId = [...programIds][0];
  const seasons = rows(table).filter(row => field(table, row, 'programId') === programId && positive(field(table, row, 'seasonNumber')) && Array.isArray(field(table, row, 'episodes')));
  if (!seasons.length) fail('catalog_incomplete', 'Katalog neobsahuje ověřený seznam epizod.');
  const latestSeason = Math.max(...seasons.map(row => field(table, row, 'seasonNumber')));
  const seasonCounts = showRows.map(row => field(table, field(table, row, 'additionals'), 'programSeasonsCount')).filter(positive);
  if (!seasonCounts.length || Math.max(...seasonCounts) !== latestSeason) fail('catalog_incomplete', 'Katalog nepotvrdil, že seznam patří poslední sérii pořadu.');
  const relevant = seasons.filter(row => field(table, row, 'seasonNumber') === latestSeason);
  const found = new Map();
  for (const row of relevant) {
    const refs = field(table, row, 'episodes');
    if (!positive(field(table, row, 'episodeCount')) || refs.length !== field(table, row, 'episodeCount') || refs.length > 100) fail('catalog_incomplete', 'Seznam epizod není úplný; poslední díl nelze spolehlivě určit.');
    for (const reference of refs) {
      if (!Number.isInteger(reference) || !plain(table[reference])) fail('catalog_changed', 'Seznam epizod má nepodporovaný formát.');
      const candidate = fullEpisode(table, table[reference], programId);
      if (candidate && candidate.season === latestSeason && candidate.seasonId === field(table, row, 'id')) found.set(candidate.url, candidate);
    }
  }
  const sorted = [...found.values()].sort((a, b) => b.season - a.season || b.number - a.number);
  if (!sorted.length || sorted.length > 100) fail('full_episode_not_verified', 'Nebylo možné ověřit celý číslovaný díl hlavního pořadu.');
  return { programId, candidates: sorted };
}
function verifyEpisode(html, candidate, programId) {
  const table = tableOf(html);
  const matches = rows(table).filter(row => field(table, row, 'webUrl') === candidate.url && field(table, row, 'type') === 'episode');
  const verified = matches.find(row => {
    const episode = fullEpisode(table, row, programId);
    return episode && episode.url === candidate.url && episode.season === candidate.season && episode.number === candidate.number;
  });
  if (!verified) fail('episode_not_verified', 'Stránka epizody nepotvrdila vybraný celý díl.');
  const publishingState = field(table, verified, 'publishingState');
  if (typeof publishingState !== 'string') fail('catalog_changed', 'Chybí výslovný stav publikace epizody.');
  if (publishingState !== 'published') return null;
  const distributions = field(table, verified, 'distributions');
  if (!Array.isArray(distributions)) fail('availability_not_verified', 'Katalog neuvádí podmínky dostupnosti celého dílu.');
  const levels = distributions.map(reference => table[reference]).filter(plain).filter(row => field(table, row, 'autoplay') === 'video' && field(table, row, 'error') === null && field(table, row, 'showLock') === false).map(row => field(table, row, 'userLevel')).filter(level => ['unregistered', 'free', 'light', 'premium'].includes(level));
  if (!levels.length) return null;
  const jsonLd = [...html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)].flatMap(match => {
    try { const data = JSON.parse(match[1]); return Array.isArray(data) ? data : Array.isArray(data['@graph']) ? data['@graph'] : [data]; } catch { return []; }
  });
  const structured = jsonLd.find(row => row?.['@type'] === 'TVEpisode' && row.url === candidate.url && Number(row.episodeNumber) === candidate.number && typeof row.partOfSeries?.name === 'string' && normalized(row.partOfSeries.name) === 'zradci');
  if (!structured || !iso(structured.datePublished)) fail('episode_not_verified', 'Nezávislá metadata stránky nepotvrdila totožnost a datum epizody.');
  const result = fullEpisode(table, verified, programId);
  if (!result.premiereDateTime || Date.parse(structured.datePublished) !== Date.parse(result.premiereDateTime)) fail('episode_not_verified', 'Datum epizody není v metadatech konzistentní.');
  return { ...result, publishingState, fullVideoAccessLevels: [...new Set(levels)].sort() };
}

export async function resolvePrimaContent({ query, selection = 'latest' } = {}, { fetchImpl = fetch } = {}) {
  if (typeof query !== 'string' || query.length > 100 || !['zradci', 'zradcu'].includes(normalized(query))) fail('unsupported_query', 'Tento adaptér umí pouze hlavní český pořad Zrádci.');
  if (!['latest', 'latest_published'].includes(selection)) fail('unsupported_selection', 'Podporovaný výběr je poslední publikovaná celá epizoda.');
  const { programId, candidates } = candidatesFromShow(await htmlPage(SHOW_URL, fetchImpl));
  for (const candidate of candidates.slice(0, 8)) {
    const verified = verifyEpisode(await htmlPage(candidate.url, fetchImpl), candidate, programId);
    if (!verified) continue;
    return { url: verified.url, title: verified.title,
      episode: { season: verified.season, number: verified.number, premiereDateTime: verified.premiereDateTime, broadcastDateTime: verified.broadcastDateTime, durationSeconds: verified.durationSeconds },
      availability: { publishingState: verified.publishingState, fullVideoAccessLevels: verified.fullVideoAccessLevels, accountChecked: false, geoChecked: false },
      evidence: { sources: [SHOW_URL, verified.url], checkedAt: new Date().toISOString(),
        selectionBasis: 'Highest season/episode number in the complete current-season catalog, confirmed published as a full episode with full-video catalog distribution.',
        dateMeaning: 'premiereDateTime/datePublished is the TV premiere metadata, which can be later than subscription pre-release; actual publication timestamp is not provided.',
        deepLinkVerified: false, playbackVerified: false } };
  }
  fail('published_episode_not_verified', 'V kontrolovaném seznamu nebyla ověřena publikovaná celá epizoda.');
}
