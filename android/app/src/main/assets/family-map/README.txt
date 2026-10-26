Home TV family map candidate

Leaflet 1.9.4 is bundled locally with its license and default marker assets.
leaflet.js/leaflet.css SHA256 match the official Leaflet download-page SRI.
vendor-manifest.json records provenance and hashes.

Sources checked 2026-10-25:
https://leafletjs.com/download.html
https://leafletjs.com/examples/quick-start/
https://operations.osmfoundation.org/policies/tiles/
https://developer.android.com/develop/ui/views/layout/webapps/load-local-content

Only the active viewport requests HTTPS tile.openstreetmap.org tiles.
No retina duplicate requests, buffer/prefetch, background refresh or bulk download.
Default Chromium HTTP cache handles Cache-Control, Expires, Etag and revalidation.
An actual packaged HTTPS appassets origin supplies a normal origin Referer;
the WebView User-Agent identifies HomeTV/<version> (org.hometv.launcher).
Visible OpenStreetMap attribution is never hidden; only its two fixed documentation
links may leave the map after an explicit user click.

Map positions come from currently available Home Assistant household state.
No fallback city or fabricated person location is inserted. Exact coincident
positions share a count badge, without moving the geographic coordinate.
Packaged JS receives bounded JSON; it has no native JavaScript bridge, HA token,
local network API access, remote scripts, frames or arbitrary URL navigation.

OpenStreetMap tile availability is best effort and requires Internet access;
previously cached tiles may remain usable according to browser cache policy.
This isolated controller does not alter MainActivity or select itself for release.
