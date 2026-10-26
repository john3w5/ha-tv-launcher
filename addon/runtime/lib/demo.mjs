export function demoDashboard(now = new Date()) {
  const at = (days, hour, minute = 0) => {
    const value = new Date(now);
    value.setDate(value.getDate() + days);
    value.setHours(hour, minute, 0, 0);
    return value.toISOString();
  };
  return {
    mode: 'demo',
    updatedAt: now.toISOString(),
    weather: { temperature: 14.6, humidity: 71, windSpeed: 2.4, rainRate: 0, pressure: 1018, condition: 'Polojasno' },
    calendars: [{ entityId: 'demo.family', name: 'Rodinný kalendář · ukázka', events: [
      { summary: 'Společná večeře', start: at(0, 19), end: at(0, 20) },
      { summary: 'Rodinný výlet', start: at(1, 10), end: at(1, 14) },
    ] }],
    cameras: [
      { id: 'entrance', name: 'Vstup · ukázka', available: false, streamType: 'none', snapshotUrl: null },
      { id: 'garden', name: 'Zahrada · ukázka', available: false, streamType: 'none', snapshotUrl: null },
    ],
    mediaPlayers: [{ entityId: 'demo.tv', name: 'Obývací pokoj · ukázka', state: 'idle', source: 'Rodinný hub' }],
    scenes: [],
    home: { lights: [
      { entityId: 'demo.kitchen', name: 'Kuchyně · ukázka', area: 'Kuchyně', role: 'light-state', state: 'on' },
      { entityId: 'demo.garden', name: 'Okolí domu · ukázka', area: 'Okolí domu', role: 'light-state', state: 'on' },
    ], locks: [{ entityId: 'demo.lock', name: 'Vstup · ukázka', state: 'unknown' }], doors: [] },
    insights: [{ id: 'demo', title: 'Ukázková data', message: 'Po propojení se zde zobrazí ověřené údaje z Home Assistantu.', tone: 'info' }],
  };
}
