/** No lock identity, device fingerprint or physical unlock route is bundled. */
export function createEntranceDoor() {
  const unavailable = async () => { throw Object.assign(new Error('Door unlatching is not included in the public edition.'), { status: 503 }); };
  return {
    capabilities: () => ({ configured: false, cameraId: 'entrance', label: 'Door', entityId: null, confirmationRequired: true }),
    status: async () => ({ configured: false, available: false, cameraId: 'entrance', label: 'Door', state: 'unknown', reason: 'Not configured in the public edition.' }),
    prepare: unavailable, commit: unavailable,
  };
}
