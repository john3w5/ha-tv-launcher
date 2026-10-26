# Development

Use Node.js 22 for backend work. There are no npm runtime dependencies to install in the current package.

```sh
npm run check
npm test
node --test ha-app/test/*.test.mjs
```

The first command checks JavaScript syntax. The other commands run backend/frontend-contract and Home Assistant app packaging/startup tests. CI uses the same Node version. Test counts can change as the source evolves, so this document does not substitute a historical count for the current run.

## Generated Home Assistant app

`ha-app/` contains the packaging source. Its `app-config.yaml` is mapped to `config.yaml` by the packager. Only the complete, committed `addon/config.yaml` is intended for App Store discovery.

After changing runtime or packaging files, generate into a fresh directory:

```sh
node ha-app/prepare-package.mjs ./dist/home-tv-launcher-app
```

Use that generated payload to update `addon/`, then run:

```sh
npm run check:addon
```

The parity check compares shipped payload/metadata independently of generated timestamps. Do not copy `.env`, personal `config.json`, photos, recordings, session stores or a developer's runtime directory into `addon/`. The packager selects maintained source files and produces a file manifest.

## Android client

The Android project includes its Gradle wrapper. Build your own debug APK using an explicit backend origin:

```sh
cd android
./gradlew :app:assembleDebug -PdashboardUrl='http://home-tv.local:4317/'
```

Use the SDK/JDK prerequisites in [setup](setup.md) and [android/README.md](../android/README.md). Native protocol checks are separate from a device test. For rendering changes, compare direct screenshots at the device's actual resolution and measure the same remote-key sequence before and after. For cameras, distinguish input/decode, queue submission, native rendering and visible motion.

## Reporting a problem

Include your Android/TV model and OS, application version, backend version, affected view and reproduction steps. A small configuration fragment with invented entity names is preferable to an unfiltered household export. Remove tokens, pairing codes, network addresses, person locations, private calendar entries and images from shared logs.
