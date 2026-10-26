import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntranceDoor } from '../lib/entrance-door.mjs';
import { createNightService } from '../lib/night-service.mjs';
import { normalizeHouseholdPanel } from '../lib/household-panel.mjs';

test('public physical-macro placeholders make no HA calls even if supplied with a client and config', async () => {
  let calls = 0;
  const ha = new Proxy({}, { get() { calls++; return () => { throw Error('unexpected HA call'); }; } });
  const door = createEntranceDoor({ ha, config: { entities: { locks: [{ entityId: 'lock.example' }] } }, enabled: true });
  assert.equal(door.capabilities().configured, false);
  assert.equal((await door.status()).available, false);
  await assert.rejects(door.prepare({ session: 'x', cameraId: 'entrance' }), { status: 503 });
  await assert.rejects(door.commit({ session: 'x', confirmationId: 'x' }), { status: 503 });
  const night = createNightService({ ha, panelConfig: { night: { scriptId: 'script.example' } } });
  await assert.rejects(night.prepare({ session: 'x' }), { status: 503 });
  await assert.rejects(night.commit({ session: 'x', confirmationId: 'x' }), { status: 503 });
  assert.equal(normalizeHouseholdPanel({ night: { scriptId: 'script.example' } }).night, null);
  assert.equal(calls, 0);
});
