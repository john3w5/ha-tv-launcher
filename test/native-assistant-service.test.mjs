import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAssistantService, validPrimaEpisodeUrl } from '../lib/native-assistant-service.mjs';

const SESSION = 'A'.repeat(32), OTHER = 'B'.repeat(32), APPS = ['com.netflix.ninja', 'cz.prima.tvapp'];
const make = extras => {
  const calls = [];
  const service = createNativeAssistantService({ ha: { async request(path, options) { calls.push({ path, options }); return { service_response: { response: { response_type: 'action_done', speech: { plain: { speech: 'Povel přijat.' } } } } }; } },
    readStatus: async () => ({ weather: { temperature: 3.7, humidity: 90, windSpeed: 2, pressure: 994, units: { temperature: '°C' } } }), ...extras });
  return { calls, service, request: text => service.request({ text, installedApps: APPS, session: SESSION }) };
};

test('read-only status uses actual HA data and performs no command or confirmation', async () => {
  const f = make(); const answer = await f.request('Jaké je venku počasí?');
  assert.equal(answer.status, 'complete'); assert.equal(answer.readOnly, true); assert.match(answer.reply, /3,7 °C/);
  assert.equal(answer.confirmationId, undefined); assert.deepEqual(f.calls, []);
});

test('native app plan requires a current installed allowlist and stays inert until confirmation', async () => {
  const f = make(); const prepared = await f.request('Otevři Netflix');
  assert.equal(prepared.status, 'confirmation'); assert.equal(prepared.nativeAction, undefined); assert.deepEqual(f.calls, []);
  await assert.rejects(() => f.service.confirm({ id: prepared.confirmationId, session: OTHER }), { code: 'confirmation_invalid' });
  const result = await f.service.confirm({ id: prepared.confirmationId, session: SESSION });
  assert.deepEqual(result.nativeAction, { type: 'launch_app', appId: 'com.netflix.ninja' });
  await assert.rejects(() => f.service.confirm({ id: prepared.confirmationId, session: SESSION }), { code: 'confirmation_invalid' });
  assert.deepEqual(f.calls, []);
  assert.equal((await f.service.request({ text: 'Otevři Netflix', installedApps: [], session: SESSION })).status, 'unsupported');
});

test('HA control is executed only after one explicit session-bound confirmation', async () => {
  const f = make(); const prepared = await f.request('Rozsviť v kuchyni');
  assert.equal(prepared.status, 'confirmation'); assert.deepEqual(f.calls, []);
  const results = await Promise.allSettled([f.service.confirm({ id: prepared.confirmationId, session: SESSION }), f.service.confirm({ id: prepared.confirmationId, session: SESSION })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { path: 'api/services/conversation/process?return_response', options: { method: 'POST', body: { text: 'Rozsviť v kuchyni', language: 'cs', agent_id: 'conversation.home_assistant' } } });
});

test('twenty-second expiry and new plans invalidate old confirmations without action', async () => {
  let now = 1000; const f = make({ now: () => now });
  const old = await f.request('Zhasni v kuchyni'); await f.request('Rozsviť v kuchyni');
  await assert.rejects(() => f.service.confirm({ id: old.confirmationId, session: SESSION }), { code: 'confirmation_invalid' });
  const prepared = await f.request('Zhasni v kuchyni'); now += 20000;
  await assert.rejects(() => f.service.confirm({ id: prepared.confirmationId, session: SESSION }), { code: 'confirmation_invalid' });
  assert.deepEqual(f.calls, []);
});

test('unknown outcome consumes a HA confirmation and cannot retry the action', async () => {
  let count = 0; const f = make({ ha: { async request() { count++; throw Error('timeout'); } } });
  const prepared = await f.request('Zhasni v kuchyni');
  await assert.rejects(() => f.service.confirm({ id: prepared.confirmationId, session: SESSION }), { code: 'ha_outcome_unknown' });
  await assert.rejects(() => f.service.confirm({ id: prepared.confirmationId, session: SESSION }), { code: 'confirmation_invalid' });
  assert.equal(count, 1);
});

test('latest Prima episode is a confirmed native handoff with strict verified URL', async () => {
  const url = 'https://www.iprima.cz/serialy/zradci/2-serie/1-epizoda';
  const f = make({ resolvePrima: async () => ({ url, title: 'Ověřená epizoda', availability: { publishingState: 'published' } }) });
  const prepared = await f.request('Pusť aplikaci iPrima a spusť poslední díl Zrádců');
  assert.equal(prepared.status, 'confirmation'); assert.match(prepared.reply, /nejsou ověřené/); assert.equal(prepared.nativeAction, undefined);
  const result = await f.service.confirm({ id: prepared.confirmationId, session: SESSION });
  assert.deepEqual(result.nativeAction, { type: 'prima_episode', appId: 'cz.prima.tvapp', url }); assert.deepEqual(f.calls, []);
  for (const bad of [url + '?x=1', url + '#x', url.replace('www.iprima.cz', 'evil.invalid'), url.replace('www.iprima.cz', 'user@www.iprima.cz'), url.replace('1-epizoda', '%31-epizoda'), 'intent://evil', 'file:///etc/passwd']) assert.equal(validPrimaEpisodeUrl(bad), false);
  const evil = make({ resolvePrima: async () => ({ url: 'https://evil.invalid/', title: 'X', availability: { publishingState: 'published' } }) });
  assert.equal((await evil.request('Spusť poslední díl Zrádců')).status, 'unsupported');
});

test('night, technical URLs, malformed sessions and invented app IDs never invoke HA', async () => {
  const f = make();
  for (const text of ['Spusť noční režim', 'Otevři https://evil.invalid', 'restart televize']) assert.equal((await f.request(text)).status, 'unsupported');
  await assert.rejects(() => f.service.request({ text: 'Otevři Netflix', installedApps: APPS, session: 'bad' }), { code: 'session_required' });
  await assert.rejects(() => f.service.request({ text: 'Otevři Netflix', installedApps: ['evil.package'], session: SESSION }), { code: 'invalid_apps' });
  assert.deepEqual(f.calls, []);
});

test('only one catalog request runs at a time and cancellation/error releases the slot', async () => {
  let rejectLookup, lookups = 0;
  const f = make({ resolvePrima: () => { lookups++; return new Promise((_, reject) => { rejectLookup = reject; }); } });
  const first = f.request('Spusť poslední díl Zrádců');
  assert.equal((await f.request('Spusť poslední díl Zrádců')).status, 'unsupported');
  assert.equal(lookups, 1);
  rejectLookup(Error('cancelled')); assert.equal((await first).status, 'unsupported');
  const next = f.request('Spusť poslední díl Zrádců'); assert.equal(lookups, 2);
  rejectLookup(Error('cancelled')); await next;
  assert.deepEqual(f.calls, []);
});
