# Architecture

## Android TV client

The main TV interface is a native Kotlin `View`. It draws cards, text, focus and transitions with Android Canvas, using a 1440 × 810 design coordinate space scaled to the real viewport. Cached RenderNodes are recorded at native pixel resolution and invalidated when their geometry or relevant content changes.

Remote actions are resolved against native focus targets. Android intents launch installed applications. Native Android dialogs handle settings, pairing and details. Camera video uses WebRTC's Android renderer; general media uses Media3. An isolated WebView is used for the optional map, not for the main launcher screen.

The client talks to one backend origin selected by the Gradle `dashboardUrl` property. Pairing and authenticated API requests use a backend session cookie. The Home Assistant access token is not an Android build parameter.

## Node.js backend

`server.mjs` serves the browser frontend and the API. The maintained source is in `server.mjs`, `lib/` and `public/`; the Home Assistant app ships a generated copy of that runtime.

The backend:

- Reads Home Assistant states, calendar data and camera snapshots through its REST API.
- Maintains Home Assistant WebSocket subscriptions for notifications, state/event updates and camera signaling.
- Projects explicitly configured entities into the dashboard contract.
- Sends live notifications, selected updates and camera signaling events to clients through server-sent events (SSE).
- Validates sessions, request origins and configured control capabilities before forwarding allowed actions.

The browser frontend supports the demo and management flows. Its existence does not change the Android launcher's native rendering path.

## API entry points

| Route | Purpose |
|---|---|
| `GET /api/bootstrap` | Mode, pairing state and available client features. |
| `POST /api/pair` | Exchange the configured pairing code for a session cookie. |
| `POST /api/logout` | Revoke that session. |
| `GET /api/dashboard` | Dashboard projection; simulated in demo mode, authenticated in live mode. |
| `GET /api/events` | Authenticated SSE updates. |
| `POST /api/cameras/:id/webrtc` | Start signaling for an explicitly configured camera. |
| `/api/webrtc/:sessionId/...` | Owner-bound trickle candidates, events and cleanup. |

These are implementation interfaces, not a promise of a stable public API version. Read the corresponding server validation and tests before building another client.

## Camera media path

For WebRTC, the Android client creates an offer, the backend exchanges signaling with Home Assistant, and candidates travel through authenticated HTTP/SSE routes. The resulting media connection uses the camera/Home Assistant integration's WebRTC peer. The Node backend does not decode or re-encode every WebRTC video frame.

Snapshots and HLS have separate backend endpoints and resource validation. Their successful loading does not establish WebRTC timing or continuous playback quality. A renderer submission counter also does not prove physical screen presentation.

## Configuration and persistence

The repository contains generic example configuration with placeholder entities. A live installation supplies its own entity IDs, credentials, pairing secrets and optional photos. Home Assistant app options select its connection and origin; persistent runtime data and session storage are kept outside the shipped runtime.

The standalone server defaults to a loopback listener. Home Assistant app deployment binds the service inside its container and exposes its configured port. After deployment the TV needs that backend and Home Assistant; a developer workstation is not part of the running system.
