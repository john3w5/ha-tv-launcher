# Known limitations

This is a source project developed and physically exercised on a TCL Android/Google TV installation. There is no completed compatibility matrix for Xiaomi TVs/boxes or other manufacturers. The declared Android minimum SDK describes build compatibility, not a guarantee that every TV firmware supports the same launcher, overlay, remote or media behavior.

## Camera playback is experimental

Camera integrations, codecs and hardware decoders differ. HD playback includes timing/queue behavior that still needs device testing. Automated tests, decoded-frame counts, network statistics and renderer submissions measure different parts of that path. None alone proves smooth visible motion on a TV.

Compare playback under consistent conditions, including whether screen mirroring or recording is active. Use a moving scene on the physical screen and report decoder errors, freezes, queue drops and renderer behavior separately. The project does not claim that disabling a mirror fixes all playback problems.

## Installation-specific features

The room data model supports explicit mappings, but a useful dashboard still requires your own entity IDs and real sensor units. Readouts and configured light/temperature controls are included. Security projections, voice commands and vacuum integrations can require code adaptation as well as configuration.

Physical door unlatching and the original household night macro are not included in this public edition. Their implementations are unavailable stubs: they return an unavailable response without sending Home Assistant requests. Enabling such functions requires a separately reviewed implementation for the intended installation. The native UI uses the backend capabilities to keep unavailable actions disabled.

The UI currently uses Czech text and some calendar/household formatting follows `Europe/Prague`. Broader localization and timezone configurability need further work.

Optional maps require an Internet connection and their providers' service availability. Google Maps and OpenStreetMap resources have their own terms and attribution requirements. A packaged Leaflet map candidate is included in the source; its presence does not establish that it is the active map controller in every build.

## Builds and tests

This repository distributes source and public third-party assets. Each user builds an APK for their own backend origin and deployment. There is no ready-to-install APK configured for an arbitrary Home Assistant system.

CI checks Node code and Home Assistant packaging. Android compilation is a separate check, followed by remote-navigation and playback checks on the intended device. A passing test suite is not a physical installation or hardware acceptance test.
