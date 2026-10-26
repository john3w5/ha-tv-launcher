# Third-party notices

The repository's [MIT license](LICENSE) covers the project's own code. The following components retain their original licenses and notices. Keep the applicable notices when redistributing source or an APK containing them.

| Component | Use | License / included notice |
|---|---|---|
| Gradle wrapper | Android build bootstrap | Apache-2.0; [android/LICENSE-Gradle.txt](android/LICENSE-Gradle.txt). Distribution URL and checksum are in `android/gradle/wrapper/gradle-wrapper.properties`. |
| AndroidX Media3 | Native media and HLS playback | Apache-2.0; fetched as the declared Maven dependencies. [AndroidX Media source/license](https://github.com/androidx/media). |
| WebRTC SDK for Android, `150.7871.04` | Native camera transport and rendering | SDK distribution MIT, upstream WebRTC BSD-style license and patent grant, plus bundled component notices. Full files are packaged under [android/app/src/main/assets/licenses/](android/app/src/main/assets/licenses/). |
| hls.js light, `1.7.3` | Browser HLS playback | Apache-2.0, with Dailymotion and Brightcove notices in [public/vendor/hls.LICENSE.txt](public/vendor/hls.LICENSE.txt). |
| Leaflet, `1.9.4` | Vendored experimental map assets | BSD-2-Clause; [LEAFLET-LICENSE.txt](android/app/src/main/assets/family-map/LEAFLET-LICENSE.txt). Copyright 2010–2023 Volodymyr Agafonkin and 2010–2011 CloudMade. |
| Natural Earth 1:110m Admin 0 Countries | Simplified map outlines | Public domain. The source/terms metadata is retained in the GeoJSON assets. [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/). |

## WebRTC files distributed in the APK

- `WEBRTC-SDK-MIT.txt`
- `WEBRTC-BSD.txt`
- `WEBRTC-PATENTS.txt`
- `WEBRTC-THIRD-PARTY.md`

The adjacent `README.txt` records upstream source URLs and checksums. The full bundled third-party notice is retained rather than replaced by this summary. Publisher source: [webrtc-sdk/android](https://github.com/webrtc-sdk/android/releases/tag/v150.7871.04).

## Maps and external services

OpenStreetMap data and tile service use their own [copyright/attribution](https://www.openstreetmap.org/copyright) and [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Google Maps is an external service with its own terms and attribution. These services are not relicensed by the project's MIT license.

Home Assistant, Android and media-service names are used to describe integrations. Their presence does not imply endorsement or affiliation. Installed application artwork is obtained from the user's device; this repository does not include a household's installed icon cache, photos or recordings.
