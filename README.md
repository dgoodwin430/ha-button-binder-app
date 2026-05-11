# Button Binder App Repository

Button Binder is a Home Assistant app, formerly called an add-on, that gives button remotes and wall keypads a focused mapping UI. It learns incoming Home Assistant events, stores the trigger signature, and calls the service you assign when the same button event appears again.

The first target is a 4-button Zemismart-style interface, but the app supports any 1-12 button layout.

## Current Shape

- Ingress web UI inside Home Assistant.
- Learns `zha_event` and `state_changed` events by default.
- Stores mappings in the app data volume at `/data/button-maps.json`.
- Calls Home Assistant services through the Supervisor Core WebSocket proxy.
- Does not edit `automations.yaml`.

## Install In Home Assistant

Repository URL:

```text
https://github.com/dgoodwin430/ha-button-binder-app
```

1. Put this repository somewhere Home Assistant can fetch, such as GitHub.
2. In Home Assistant, open **Settings > Apps**.
3. Open the repository menu and add the repository URL.
4. Install **Button Binder**.
5. Start the app and open the web UI.

For local development on a Home Assistant OS install, copy the `button_binder` folder into `/addons/button_binder`, reload the app store, then install **Button Binder** from local apps.

## Develop Locally

From the app folder:

```sh
cd button_binder
npm install
BUTTON_BINDER_DATA_DIR=/tmp/button-binder PORT=8099 npm start
```

The local UI will run at `http://localhost:8099`. Without a Home Assistant token, the UI still opens but event learning and service calls are offline.

For live Home Assistant testing outside the app container, set:

```sh
HA_WS_URL=ws://homeassistant.local:8123/api/websocket
HA_TOKEN=your_long_lived_access_token
BUTTON_BINDER_DATA_DIR=/tmp/button-binder
npm start
```
