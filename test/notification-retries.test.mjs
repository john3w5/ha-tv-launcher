import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationRetries } from '../lib/notification-retries.mjs';

const notice = { id: 'first', title: 'Domov', message: 'Hotovo', type: 'info' };

test('webhook retry suppression is bounded to ten seconds and does not extend with retries', () => {
  let time = 100;
  const retries = createNotificationRetries({ now: () => time });
  assert.deepEqual(retries.claim(notice), { duplicate: false, id: 'first' });
  time += 9999;
  assert.deepEqual(retries.claim({ ...notice, id: 'retry', expiresAt: 'a different expiry' }), { duplicate: true, id: 'first' });
  time += 1;
  assert.deepEqual(retries.claim({ ...notice, id: 'next-episode' }), { duplicate: false, id: 'next-episode' });
});

test('explicit event IDs preserve distinct identical episodes; meaningful text and severity changes pass', () => {
  const retries = createNotificationRetries({ now: () => 0 });
  assert.equal(retries.claim(notice, 'episode:one').duplicate, false);
  assert.equal(retries.claim({ ...notice, id: 'two' }, 'episode:two').duplicate, false);
  assert.equal(retries.claim({ ...notice, id: 'retry' }, 'episode:one').duplicate, true);
  for (const change of [{ title: 'Nový titulek' }, { message: 'Nový obsah' }, { type: 'urgent' }]) {
    assert.equal(retries.claim({ ...notice, ...change }, 'episode:one').duplicate, false);
  }
  retries.clear();
  assert.equal(retries.claim(notice, 'episode:one').duplicate, false);
});

test('retry cache evicts older entries rather than growing without a bound', () => {
  const retries = createNotificationRetries({ now: () => 0, maxEntries: 2 });
  for (const event of ['one', 'two', 'three']) assert.equal(retries.claim(notice, event).duplicate, false);
  assert.equal(retries.claim(notice, 'two').duplicate, true);
  assert.equal(retries.claim(notice, 'one').duplicate, false);
});
