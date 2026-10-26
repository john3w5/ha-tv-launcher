# Your Home Assistant mapping

Start with `config.example.json`. For a standalone server, copy it to the untracked `config.json`; for the Home Assistant app, use the persistent-config process documented in [ha-app/README.md](../ha-app/README.md).

The example configuration contains clearly named `example_*` placeholders. Replace or remove them and configure the actual sources you want to display. Home Assistant area names and device names do not automatically establish which sensor measures a particular room.

## Rooms

`domesticPanel.rooms` is the explicit source for room identity and order. Each room can contain environment sensors, one primary climate controller, presence sensors and equipment. For example, the following fragment illustrates the field names; the entity IDs are placeholders:

```json
{
  "domesticPanel": {
    "rooms": [
      {
        "id": "example-room",
        "name": "Example room",
        "temperatureEntityId": "sensor.example_room_temperature",
        "humidityEntityId": "sensor.example_room_humidity",
        "co2EntityId": "sensor.example_room_co2",
        "entityId": "climate.example_room",
        "heatingPowerEntityId": "sensor.example_room_heater_power"
      }
    ]
  }
}
```

Merge your mappings into the complete configuration rather than replacing unrelated sections with this fragment. A room can be sensor-only; a separate air-conditioning device does not have to become a second room.

For the v2 room projection:

- The large temperature comes from the explicit temperature sensor. An unavailable sensor does not fall back to the controller's temperature.
- Humidity, CO₂ and PM2.5 use their own validated source and unit. Unavailable data stays unavailable; zero remains a valid measurement.
- The controller's target and reported action are distinct from environmental measurements.
- A confirmed heating label requires an explicitly mapped, valid heater power reading. A requested heating mode is not proof that the physical heater is running.
- Presence and contacts have true/false/unknown states. Unknown does not mean absent or closed.

The interface uses pages when configured content exceeds the current screen capacity. It does not require scrolling through a long room list.

## Other panels

Use the existing sections of the example file for calendar/weather, cameras, energy/water, laundry/vacuum, notifications and optional household features. Add only the fields you need. Some integrations require particular Home Assistant entity domains, attributes or units; the normalizers in `lib/` define the accepted contract.

Configured light and temperature controls use the backend's explicit capability model. Other integrations can require code adaptation as well as configuration. Physical door unlatching and the original household night macro are unavailable in the public edition; they require separately reviewed implementations. Read-only sensor mapping alone does not establish a working alarm or vacuum-control workflow. See [known limitations](limitations.md).

## Origins, pairing and secrets

`TV_PUBLIC_ORIGIN` for a standalone server, or `public_origin` in app options, is the backend address used by clients. Build `dashboardUrl` with the same origin. Requests using an unconfigured host/origin can be rejected even when the server is reachable.

The Home Assistant token, TV pairing code and webhook secret have different purposes. Set your own values and retain them only in your deployment's private settings. Keep runtime configuration, session stores and photos out of Git commits and shared diagnostic bundles. HTTPS is the appropriate deployment choice when the connection is exposed beyond a trusted local network.
