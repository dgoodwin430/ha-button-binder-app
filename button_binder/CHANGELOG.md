# Changelog

## 0.2.0

- Added state followers for mirroring source entity state to another switch, light, or helper entity.
- State followers listen to `state_changed` internally without flooding Recent Events.
- Added manual follower sync controls.

## 0.1.5

- Prevent live event updates from re-rendering the binding editor.
- Added pause and clear controls for the Recent Events panel.
- Changed the default watched event type to `zha_event` only to avoid `state_changed` noise.

## 0.1.4

- Start Node through `with-contenv` so Home Assistant-provided environment variables are available.

## 0.1.3

- Explicitly set the Supervisor API role for token injection.

## 0.1.2

- Enabled Supervisor API access so Home Assistant reliably injects `SUPERVISOR_TOKEN`.

## 0.1.1

- Added clearer Home Assistant connection diagnostics in the UI and logs.

## 0.1.0

- Initial app scaffold.
- Added ingress UI for button interfaces and bindings.
- Added event learning and Home Assistant service calls.
- Added persistent `/data/button-maps.json` storage.
