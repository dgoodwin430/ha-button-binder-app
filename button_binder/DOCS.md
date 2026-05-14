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

The app watches this event type by default:

- `zha_event`

For ZHA remotes, Home Assistant usually emits `zha_event` with fields like `device_id`, `endpoint_id`, and `command`.

For Zigbee2MQTT through Home Assistant entities, button actions often appear as `state_changed` events on an action sensor or event entity. Add `state_changed` only if your remote does not show up while learning with `zha_event`.

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

## State Followers

State followers keep another switch, light, or helper entity in sync with the real thing you are controlling.

Example:

- Source entity: `light.kitchen`
- Follower entity: `switch.keypad_button_1`

When `light.kitchen` turns on, Button Binder calls `switch.turn_on` for `switch.keypad_button_1`. When `light.kitchen` turns off, it calls `switch.turn_off`.

Use this for a second 4-button switch that shows the state of each controlled entity.

The common path is to configure the follower inside the button binding:

1. Open the binding card for the button.
2. Set the action entity.
3. Enable **Sync indicator**.
4. Set **Indicator entity** to the matching button or indicator entity on the other switch.
5. Save the binding.

The **Source** field defaults to the binding action entity. Change it only when the indicator should follow a different entity than the action target.

The separate **State Followers** panel is still available as an advanced overview and for followers that are not tied to one button binding.

Advanced steps:

1. Open **State Followers**.
2. Add one follower per button.
3. Set **Source entity** to the light, switch, or other thing being controlled.
4. Set **Follower entity** to the indicator button/switch entity.
5. Save.
6. Press **Sync** or **Sync All** once to align the current state.

Use **Invert** if the follower should be on when the source is off.

For grouped source entities, **Group on** defaults to **After app command**. That means Button Binder will not turn the follower on just because one member of a light group turned on. It will only mirror the group turning on when Button Binder recently commanded that source entity. This prevents follower switches from accidentally turning an entire group on.

Use **Always** only when the follower entity is a safe indicator/helper and turning it on will not actuate the same group. Use **Never** when the follower should only mirror the off state.

## Data

Mappings are stored in:

```text
/data/button-maps.json
```

This is the app data volume, so mappings survive app restarts and updates.

## Notes

- The app must be running for mapped button actions to fire.
- The app must be running for state followers to stay synchronized.
- Button Binder does not edit `automations.yaml`.
- The app needs Home Assistant API access because it listens to events and calls services.
