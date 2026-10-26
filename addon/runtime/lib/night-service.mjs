/** The public edition does not ship an installation-specific physical macro. */
export class NightModeError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
export function createNightService() {
  const unavailable = async () => { throw new NightModeError('NIGHT_UNAVAILABLE', 503, 'Night automation is not included in the public edition.'); };
  return { prepare: unavailable, commit: unavailable };
}
