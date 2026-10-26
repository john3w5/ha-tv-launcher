# Installation and pairing

You need a TV that can install Android TV applications, a backend reachable from that TV, and your own Home Assistant entity configuration. Start with the browser demo to inspect the interface before configuring live data.

## 1. Choose where the backend runs

### Home Assistant App Store

On a Home Assistant installation that supports apps:

1. Open **Settings → Apps → App Store** and the repository management menu.
2. Add `https://github.com/michalschoniger-ops/home-tv-launcher`.
3. Install **Home TV Launcher** from that repository.
4. Set `public_origin` to the address the TV will actually use, including the exposed port. For example, `http://home-tv.local:4317` is suitable only if your own network resolves that name to the backend.
5. Set your own pairing code, with at least eight characters. Keep it separate from the Home Assistant access token and webhook secret.
6. Replace or remove the `example_*` entity placeholders with your own mapping and start the app. Installation does not discover rooms automatically.

The `supervisor` connection uses the runtime credential supplied by Home Assistant. The alternative `direct` connection requires your own `ha_url` and `ha_access_token`. Follow the complete option and persistent-config instructions in [ha-app/README.md](../ha-app/README.md).

App Store repository installation is described in the [official Home Assistant instructions](https://www.home-assistant.io/common-tasks/os/#installing-a-third-party-app-repository). The checked-in [`addon/`](../addon/) directory contains the deployable build context; [`ha-app/`](../ha-app/) contains its maintained packaging source.

### Standalone Node.js server

Use Node.js 22. From the repository root:

```sh
cp .env.example .env
cp config.example.json config.json
```

Edit `.env` with your own settings:

```dotenv
HOST=0.0.0.0
PORT=4317
HA_URL=https://homeassistant.example.net
HA_TOKEN=REPLACE_WITH_YOUR_HOME_ASSISTANT_TOKEN
TV_CLIENT_TOKEN=REPLACE_WITH_YOUR_OWN_PAIRING_CODE
TV_WEBHOOK_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
TV_PUBLIC_ORIGIN=http://home-tv.local:4317
CONFIG_PATH=./config.json
TV_SESSION_STORE=./private/state/paired-sessions.json
```

The host names and credential strings above are placeholders. `TV_PUBLIC_ORIGIN` must match the scheme, host and port used by the TV and browser. Edit `config.json` to reference your own entities, then run `npm start`. When using a reverse proxy, preserve streaming SSE responses and use the same external origin in the Android build.

`demo` means no Home Assistant connection was supplied. `setup` means the live connection, config or pairing settings are incomplete. `live` means the backend has the required settings; individual entities can still be unavailable. Check each displayed source rather than treating `live` as proof that all devices are online.

## 2. Build your TV APK

Install Android Studio or the Android SDK, Android SDK Platform 36 and a JDK compatible with the included Android Gradle Plugin; the project targets Java 17. Open `android/` in Android Studio or use its included Gradle wrapper:

```sh
cd android
./gradlew :app:assembleDebug \
  -PdashboardUrl='http://home-tv.local:4317/'
```

Replace the URL with your own backend origin. The TV connects to this address directly. HTTP builds allow cleartext only to the explicitly selected LAN host; HTTPS builds use system certificate trust. A hostname that resolves on your computer may still need a DNS/network change to resolve on the TV.

For a smaller device-specific APK you can also pass `-PtvAbi=arm64-v8a` or `-PtvAbi=armeabi-v7a`, after checking the actual device ABI. The output is `android/app/build/outputs/apk/debug/app-debug.apk`, relative to the repository root. It is a development-signed APK; maintain your own signing key for ongoing personal releases.

The application ID is `org.hometv.launcher`. Build tools and native dependencies are fetched from the repositories declared in the Android project; no household APK or private build cache is required.

## 3. Install and pair

Transfer the APK to your own TV, or install it through an already authorized Android debugging connection:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Open **Home TV Launcher**, open its settings/pairing screen, and enter the pairing code configured on your backend. Successful pairing creates a backend session; it does not copy the Home Assistant token into the APK. With a persistent session store, the backend can retain pairing through a restart.

Select the launcher using the TV's Home-app settings where supported. This selection, overlay permission and remote-key behavior vary by manufacturer. Optional notifications over other applications require the corresponding Android overlay permission.

Check Home, arrow navigation, Back, app launch and return, a backend refresh while a different app tile is selected, and any camera profile you intend to use. Hardware playback needs a moving scene and observation on the actual TV. See [limitations](limitations.md).

## Maintaining a local Home Assistant package

For a custom checkout, create a new package directory:

```sh
node ha-app/prepare-package.mjs ./dist/home-tv-launcher-app
```

The destination must not already exist. Copy the resulting package into your own local Home Assistant apps/addons directory using your installation's supported file access, then reload the App Store. Configuration and credentials belong to that installation's persistent data, rather than the source package. [Development](development.md) describes regenerating the committed `addon/` payload.
