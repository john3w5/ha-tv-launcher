import test from 'node:test';
import assert from 'node:assert/strict';
import { readDashboard } from '../lib/home-assistant.mjs';

const main = 'camera.front_main';
const low = 'camera.front_low';
const cameraState = (entity_id, state = 'idle', supported_features = 2) => ({
  entity_id, state, attributes: { supported_features, access_token: 'private-camera-token', entity_picture: '/private-image' },
});
async function camera(states, streamEntityId = low) {
  const config = { entities: { cameras: [{ id: 'front', name: 'Vchod', entityId: main, ...(streamEntityId === undefined ? {} : { streamEntityId }) }] }, calendarDays: 7, safeScenes: [] };
  return (await readDashboard({ states: async () => states }, config)).cameras[0];
}

test('camera exposes quality modes only for two available configured stream profiles', async () => {
  assert.deepEqual(await camera([cameraState(main), cameraState(low)]), {
    id: 'front', name: 'Vchod', available: true, streamType: 'hls', hasQualityModes: true,
    snapshotUrl: '/api/cameras/front/snapshot',
  });
});

test('missing, unavailable or snapshot-only alternate profile cannot advertise quality modes', async () => {
  for (const alternate of [null, cameraState(low, 'unavailable'), cameraState(low, 'unknown'), cameraState(low, 'idle', 0)]) {
    const result = await camera([cameraState(main), ...(alternate ? [alternate] : [])]);
    assert.equal(result.hasQualityModes, false);
    assert.equal(result.streamType, 'hls');
    assert.equal(result.available, true);
  }
  assert.equal((await camera([cameraState(main, 'unavailable'), cameraState(low)])).hasQualityModes, false);
});

test('invalid or identical alternate ID is ignored without exposing camera attributes', async () => {
  for (const alternateId of [main, 'sensor.front_low', 'camera.front_low?token=secret', '', null]) {
    const result = await camera([cameraState(main), cameraState(low), cameraState(alternateId)], alternateId);
    assert.equal(result.hasQualityModes, false);
    assert.ok(!JSON.stringify(result).includes('private-camera-token'));
    assert.ok(!JSON.stringify(result).includes('private-image'));
  }
});
