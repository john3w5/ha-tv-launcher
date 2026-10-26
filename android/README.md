# Home TV — native Android TV launcher

Home TV is a native Canvas launcher with remote-friendly pages, application shortcuts,
a family calendar, Home Assistant bridge data, room measurements, notifications,
media playback and map views. The public application ID is `org.hometv.launcher`.
The source defaults to an unpaired, generic `http://home-tv.local:4317/` bridge;
no personal server addresses, people, sensor IDs, photos or credentials are shipped.

## Build

Use JDK 21, Android SDK platform 36 and Build Tools 35.0.0. The wrapper pins Gradle
8.13; the project uses AGP 8.13.2, Kotlin 2.2.20, JVM 17 and minSdk 24. Install the
SDK and set `ANDROID_HOME` and `JAVA_HOME` locally before building:

```sh
./gradlew -PdashboardUrl=http://home-tv.local:4317/ :app:assembleDebug
```

`dashboardUrl` must be one explicit server origin, without user information, path,
query or fragment. HTTPS is supported. HTTP is allowed only for a private IPv4,
`localhost`, `.local` or `.home.arpa` host; Android's generated network policy opens
cleartext traffic only to that exact selected host. No server discovery, previous
household session migration or network fallback is included.

Optional `-PtvAbi=armeabi-v7a` or `-PtvAbi=arm64-v8a` limits native libraries.
WebRTC normally resolves `io.github.webrtc-sdk:android:150.7871.04` from Maven.
For a pre-provisioned offline build, pass `-PwebrtcAarPath=/path/to/android-150.7871.04.aar`
and `--offline`; all other Gradle/Android dependencies must already be cached.
No local AAR path, SDK path, build output or signing key belongs in version control.
The debug APK is generated under `app/build/outputs/apk/debug/`.

## Pairing and data

The launcher talks only to its configured bridge's fixed API routes. Pair the TV
with your own bridge after installation. Home Assistant credentials remain on the
bridge; the Android app stores only its own paired session cookie. Measurements
are supplied by explicit backend mappings. An unavailable primary sensor is never
replaced with a regulator reading; regulator mode and measured heating power remain
separate. No demo measurement is represented as a live value.

Notification overlays require explicit Android overlay/notification permission.
Door and night-action integrations remain gated by the bridge's available capability,
preparation and confirmation APIs. This repository contains no configured household
action, device credential or automatically executed hardware test.

Google Maps receives only currently available coordinates supplied by your bridge;
it has no fixed person, home coordinates, fallback location or HA login. Displaying
Google Maps sends those coordinates to Google. The separate Leaflet/OSM candidate
also binds only runtime positions and keeps visible map attribution. It is not the
active map controller by default.

## Experimental cameras

The current camera source includes an **experimental** absolute-clock pacer and
bounded timing diagnostics. Offline tests and a successful APK build do not prove
smooth playback, native rendering, device compatibility or physical screen quality.
Camera pacing has not received full physical acceptance for this public release.
Validate your own source, codec, device, image fit and timing before relying on it.
Debug traces are numeric and contain no image buffers or credentials; treat any
runtime diagnostic export as private operational data.

Third-party notices and bundled licenses are retained in `THIRD_PARTY_NOTICES.md`
and `app/src/main/assets/licenses/`. No build or verification step installs the app
or connects to a television, Home Assistant or a production household.
