# Button Binder

## Setup

1. Install and start the app.
2. Open the app web UI.
3. Add a button interface. The default is a 4-button Zemismart-style layout.
4. Press **Learn** on a binding.
5. Press the physical button.
6. Choose the service action, target entity, and optional JSON service data.
7. Save the binding.

## Event Types

The app watches these event types by default:

- `zha_event`
- `state_changed`

For ZHA remotes, Home Assistant usually emits `zha_event` with fields like `device_id`, `endpoint_id`, and `command`.

For Zigbee2MQTT through Home Assistant entities, button actions often appear as `state_changed` events on an action sensor or event entity.

You can add more event types in the app configuration:

```yaml
event_types:
  - zha_event
  - state_changed
  - deconz_event
  - zwave_js_value_notification
```

Restart the app after changing event types.

## Actions

Each binding calls one Home Assistant service:

- Domain: `light`, `switch`, `scene`, `script`, and so on.
- Service: `toggle`, `turn_on`, `turn_off`, or any service exposed by Home Assistant.
- Entity: optional `entity_id` target.
- Data: optional JSON service data.

Examples:

```json
{}
```

```json
{
  "brightness_pct": 35
}
```

## Data

Mappings are stored in:

```text
/data/button-maps.json
```

This is the app data volume, so mappings survive app restarts and updates.

## Notes

- The app must be running for mapped button actions to fire.
- Button Binder does not edit `automations.yaml`.
- The app needs Home Assistant API access because it listens to events and calls services.
