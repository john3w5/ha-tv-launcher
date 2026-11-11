import test from 'node:test';
import assert from 'node:assert/strict';
import { createStravaLunch, due, normalizeMeal } from '../lib/strava-lunch.mjs';

test('pickup codes map to served, not served and unknown', () => {
  assert.deepEqual(normalizeMeal({ datum: '2026-11-10T00:00:00', cas: '13:45', druh: 'Oběd 1', nazev: 'Kari čočka', pocet: 1, vydano: 1 }),
    { date: '2026-11-10', time: '13:45', kind: 'Oběd 1', name: 'Kari čočka', served: true, label: 'Vydáno' });
  assert.equal(normalizeMeal({ datum: '11.11.2026', vydano: 0 }).served, false);
  assert.equal(normalizeMeal({ datum: '11.11.2026', vydano: 0 }).date, '2026-11-11');
  assert.equal(normalizeMeal({ datum: '2026-11-12', vydano: -1 }).served, null);
  assert.equal(normalizeMeal({ datum: 'zítra', vydano: 1 }), null);
});

test('pickup is read on start and then after 7:00 and after 17:00 Prague time', () => {
  assert.equal(due(null, new Date('2026-11-11T03:00:00Z')).due, true);
  assert.equal(due('start', new Date('2026-11-11T05:00:00Z')).due, false);
  assert.deepEqual(due('2026-11-10 evening', new Date('2026-11-11T06:30:00Z')), { slot: '2026-11-11 morning', due: true });
  assert.equal(due('2026-11-11 morning', new Date('2026-11-11T15:30:00Z')).due, false);
  assert.deepEqual(due('2026-11-11 morning', new Date('2026-11-11T16:10:00Z')), { slot: '2026-11-11 evening', due: true });
  assert.equal(due('2026-11-11 evening', new Date('2026-11-11T22:00:00Z')).due, false);
});

test('the parent account is read without ordering and children are matched by first name', async () => {
  const calls = [];
  const replies = {
    '/api/loginPA': { SID: 'pa' }, '/api/jidelnyPA': { jidelny: [{ IDJidelny: '1234', IDUcetJidelny: '7', PopisUctuJidelny: 'Matyáš Pospíšil' }] },
    '/api/canteenLoginPA': 'canteen-sid', '/api/s4Polozky': { urlwsdl_s: ['https://s5.example'], ign_cert: ['N'] }, '/api/nactiVlastnostiPA': {},
    '/api/vydej': [{ datum: '2026-11-10', cas: '13:45', druh: 'Oběd 1', nazev: 'Kari čočka', vydano: 1 }],
  };
  const fetch = async (url, init) => { const path = new URL(url).pathname; calls.push([path, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => replies[path] }; };
  const lunch = createStravaLunch({ email: 'a@example.cz', password: 'x', fetch, log: {}, now: () => new Date('2026-11-11T16:30:00Z') });
  await lunch.refresh(); lunch.stop();
  assert.deepEqual(calls.map(call => call[0]), ['/api/loginPA', '/api/jidelnyPA', '/api/canteenLoginPA', '/api/s4Polozky', '/api/nactiVlastnostiPA', '/api/vydej']);
  assert.deepEqual(calls.at(-1)[1], { cislo: '1234', s5url: 'https://s5.example', sid: 'canteen-sid', ignoreCert: false, lang: 'CZ' });
  const snapshot = lunch.snapshot(['Maty', 'Marek']);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.children.map(child => [child.name, child.matched, child.meals.length]), [['Maty', true, 1], ['Marek', false, 0]]);
  assert.doesNotMatch(JSON.stringify(snapshot), /a@example|"x"/);
});
