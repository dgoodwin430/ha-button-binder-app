import crypto from "crypto";
import express from "express";
import fs from "fs/promises";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.INGRESS_PORT || 8099);
const DATA_DIR = process.env.BUTTON_BINDER_DATA_DIR || "/data";
const STORE_PATH = path.join(DATA_DIR, "button-maps.json");
const OPTIONS_PATH = process.env.BUTTON_BINDER_OPTIONS_PATH || "/data/options.json";
const HA_WS_URL = process.env.HA_WS_URL || "ws://supervisor/core/websocket";
const HA_TOKEN = await readHomeAssistantToken();
const DEFAULT_EVENT_TYPES = ["zha_event"];
const MAX_RECENT_EVENTS = 30;
const RECENT_EVENT_BROADCAST_INTERVAL_MS = 750;
const RECENT_COMMAND_WINDOW_MS = 8000;

let store = createDefaultStore();
let addonOptions = { event_types: DEFAULT_EVENT_TYPES };
let learning = null;
let recentEvents = [];
let recentEventBroadcastTimer = null;
let clientSockets = new Set();
let recentlyCommandedEntities = new Map();

const ha = {
  authed: false,
  connected: false,
  lastClose: null,
  lastConnectedAt: null,
  lastError: null,
  lastMessageAt: null,
  nextId: 1,
  pending: new Map(),
  phase: HA_TOKEN ? "starting" : "missing_token",
  reconnectTimer: null,
  services: null,
  stateByEntity: new Map(),
  states: [],
  subscriptions: new Map(),
  watchedEventTypes: [],
  ws: null,
};

const app = express();
const server = http.createServer(app);
const clientWss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/status", (_req, res) => {
  res.json({
    connected: ha.connected && ha.authed,
    learning,
    lastClose: ha.lastClose,
    lastConnectedAt: ha.lastConnectedAt,
    lastError: ha.lastError,
    lastMessageAt: ha.lastMessageAt,
    phase: ha.phase,
    tokenPresent: Boolean(HA_TOKEN),
    watchedEventTypes: ha.watchedEventTypes,
  });
});

app.get("/api/data", (_req, res) => {
  res.json({ store, learning, recentEvents });
});

app.post("/api/interfaces", async (req, res, next) => {
  try {
    const name = cleanString(req.body.name) || "Zemismart 4 Button Remote";
    const buttonCount = clampNumber(req.body.buttonCount, 1, 12, 4);
    const iface = createButtonInterface(name, buttonCount);
    store.interfaces.push(iface);
    await saveStore();
    broadcast({ type: "data", store });
    res.status(201).json(iface);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/interfaces/:interfaceId", async (req, res, next) => {
  try {
    const iface = findInterface(req.params.interfaceId);
    if (!iface) {
      res.status(404).json({ error: "Interface not found" });
      return;
    }

    if (req.body.name !== undefined) {
      iface.name = cleanString(req.body.name) || iface.name;
    }

    await saveStore();
    broadcast({ type: "data", store });
    res.json(iface);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/interfaces/:interfaceId", async (req, res, next) => {
  try {
    const index = store.interfaces.findIndex((iface) => iface.id === req.params.interfaceId);
    if (index === -1) {
      res.status(404).json({ error: "Interface not found" });
      return;
    }

    store.interfaces.splice(index, 1);
    await saveStore();
    broadcast({ type: "data", store });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.patch("/api/buttons/:buttonId", async (req, res, next) => {
  try {
    const found = findButton(req.params.buttonId);
    if (!found) {
      res.status(404).json({ error: "Button not found" });
      return;
    }

    if (req.body.label !== undefined) {
      found.button.label = cleanString(req.body.label) || found.button.label;
    }

    await saveStore();
    broadcast({ type: "data", store });
    res.json(found.button);
  } catch (error) {
    next(error);
  }
});

app.post("/api/buttons/:buttonId/bindings", async (req, res, next) => {
  try {
    const found = findButton(req.params.buttonId);
    if (!found) {
      res.status(404).json({ error: "Button not found" });
      return;
    }

    const binding = createBinding(cleanString(req.body.name) || "Press");
    found.button.bindings.push(binding);
    await saveStore();
    broadcast({ type: "data", store });
    res.status(201).json(binding);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/bindings/:bindingId", async (req, res, next) => {
  try {
    const found = findBinding(req.params.bindingId);
    if (!found) {
      res.status(404).json({ error: "Binding not found" });
      return;
    }

    updateBinding(found.binding, req.body);
    await saveStore();
    broadcast({ type: "data", store });
    res.json(found.binding);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/bindings/:bindingId", async (req, res, next) => {
  try {
    const found = findBinding(req.params.bindingId);
    if (!found) {
      res.status(404).json({ error: "Binding not found" });
      return;
    }

    found.button.bindings = found.button.bindings.filter((binding) => binding.id !== req.params.bindingId);
    store.followers = store.followers.filter((follower) => follower.binding_id !== req.params.bindingId);
    if (learning?.bindingId === req.params.bindingId) {
      learning = null;
    }

    await saveStore();
    broadcast({ type: "data", store });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/bindings/:bindingId/learn", (req, res) => {
  const found = findBinding(req.params.bindingId);
  if (!found) {
    res.status(404).json({ error: "Binding not found" });
    return;
  }

  learning = {
    bindingId: found.binding.id,
    buttonId: found.button.id,
    interfaceId: found.iface.id,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString(),
  };
  broadcast({ type: "learning", learning });
  res.json({ learning });
});

app.post("/api/learn/stop", (_req, res) => {
  learning = null;
  broadcast({ type: "learning", learning });
  res.json({ learning });
});

app.post("/api/events/clear", (_req, res) => {
  recentEvents = [];
  clearTimeout(recentEventBroadcastTimer);
  recentEventBroadcastTimer = null;
  broadcast({ type: "event", recentEvents });
  res.json({ recentEvents });
});

app.post("/api/followers", async (req, res, next) => {
  try {
    const follower = createStateFollower(cleanString(req.body.name) || "State follower");
    updateStateFollower(follower, req.body);
    store.followers.push(follower);
    await saveStore();
    broadcast({ type: "data", store });
    res.status(201).json(follower);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/followers/:followerId", async (req, res, next) => {
  try {
    const follower = findStateFollower(req.params.followerId);
    if (!follower) {
      res.status(404).json({ error: "State follower not found" });
      return;
    }

    updateStateFollower(follower, req.body);
    await saveStore();
    broadcast({ type: "data", store });
    res.json(follower);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/followers/:followerId", async (req, res, next) => {
  try {
    const index = store.followers.findIndex((follower) => follower.id === req.params.followerId);
    if (index === -1) {
      res.status(404).json({ error: "State follower not found" });
      return;
    }

    store.followers.splice(index, 1);
    await saveStore();
    broadcast({ type: "data", store });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/followers/:followerId/sync", async (req, res, next) => {
  try {
    const follower = findStateFollower(req.params.followerId);
    if (!follower) {
      res.status(404).json({ error: "State follower not found" });
      return;
    }

    await syncStateFollowerFromCurrentState(follower, "manual");
    await saveStore();
    broadcast({ type: "data", store });
    res.json(follower);
  } catch (error) {
    next(error);
  }
});

app.post("/api/followers/sync", async (_req, res, next) => {
  try {
    const results = [];
    for (const follower of store.followers) {
      if (!follower.enabled) {
        continue;
      }

      try {
        await syncStateFollowerFromCurrentState(follower, "manual");
        results.push({ id: follower.id, ok: true });
      } catch (error) {
        follower.lastError = error.message;
        results.push({ id: follower.id, ok: false, error: error.message });
      }
    }

    await saveStore();
    broadcast({ type: "data", store });
    res.json({ results });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bindings/:bindingId/test", async (req, res, next) => {
  try {
    const found = findBinding(req.params.bindingId);
    if (!found) {
      res.status(404).json({ error: "Binding not found" });
      return;
    }

    await callBindingAction(found.binding, "manual");
    await saveStore();
    broadcast({ type: "data", store });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ha/entities", async (_req, res, next) => {
  try {
    const states = await getHaStates();
    res.json(states);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ha/services", async (_req, res, next) => {
  try {
    const services = await getHaServices();
    res.json(services);
  } catch (error) {
    next(error);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Unexpected error" });
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", `http://${request.headers.host}`).pathname;
  if (!pathname.endsWith("/events")) {
    socket.destroy();
    return;
  }

  clientWss.handleUpgrade(request, socket, head, (ws) => {
    clientWss.emit("connection", ws, request);
  });
});

clientWss.on("connection", (ws) => {
  clientSockets.add(ws);
  ws.send(JSON.stringify({ type: "hello", store, learning, recentEvents }));
  ws.on("close", () => clientSockets.delete(ws));
});

await loadOptions();
await loadStore();
connectHomeAssistant();
setInterval(expireLearningSession, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Button Binder listening on port ${PORT}`);
});

function createDefaultStore() {
  return {
    version: 2,
    followers: [],
    interfaces: [],
  };
}

function createButtonInterface(name, buttonCount) {
  return {
    id: uid(),
    name,
    createdAt: new Date().toISOString(),
    buttons: Array.from({ length: buttonCount }, (_value, index) => ({
      id: uid(),
      label: `Button ${index + 1}`,
      bindings: [createBinding("Single press")],
    })),
  };
}

async function readHomeAssistantToken() {
  const envToken = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN;
  if (envToken) {
    return envToken;
  }

  const tokenFiles = [
    "/var/run/s6/container_environment/SUPERVISOR_TOKEN",
    "/run/s6/container_environment/SUPERVISOR_TOKEN",
  ];

  for (const tokenFile of tokenFiles) {
    try {
      const token = (await fs.readFile(tokenFile, "utf8")).trim();
      if (token) {
        return token;
      }
    } catch {
      // Try the next known s6 environment path.
    }
  }

  return "";
}

function createBinding(name) {
  return {
    id: uid(),
    name,
    enabled: true,
    trigger: null,
    action: {
      domain: "light",
      service: "toggle",
      target: { entity_id: "" },
      service_data: {},
    },
    createdAt: new Date().toISOString(),
    lastTriggeredAt: null,
  };
}

function createStateFollower(name) {
  return {
    id: uid(),
    name,
    binding_id: "",
    enabled: true,
    source_entity_id: "",
    follower_entity_id: "",
    group_on_mode: "binder",
    invert: false,
    createdAt: new Date().toISOString(),
    lastSyncedAt: null,
  };
}

async function loadOptions() {
  try {
    const raw = await fs.readFile(OPTIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    addonOptions = {
      event_types: normalizeEventTypes(parsed.event_types),
    };
  } catch {
    addonOptions = { event_types: DEFAULT_EVENT_TYPES };
  }
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    store = migrateStore(parsed);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read store, starting fresh: ${error.message}`);
    }
    store = createDefaultStore();
    await saveStore();
  }
}

function migrateStore(value) {
  if (!value || typeof value !== "object") {
    return createDefaultStore();
  }

  const followers = Array.isArray(value.followers) ? value.followers.map((follower) => ({
    binding_id: "",
    group_on_mode: "binder",
    ...follower,
  })) : [];

  return {
    version: 2,
    followers,
    interfaces: Array.isArray(value.interfaces) ? value.interfaces : [],
  };
}

async function saveStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function connectHomeAssistant() {
  if (!HA_TOKEN) {
    ha.lastError = "SUPERVISOR_TOKEN or HA_TOKEN is not set";
    ha.phase = "missing_token";
    console.warn("Home Assistant token is not available. Running UI only.");
    return;
  }

  clearTimeout(ha.reconnectTimer);
  ha.phase = "connecting";
  ha.lastClose = null;
  ha.ws = new WebSocket(HA_WS_URL);
  ha.authed = false;
  ha.connected = false;
  ha.lastError = null;

  ha.ws.on("open", () => {
    ha.connected = true;
    ha.lastConnectedAt = new Date().toISOString();
    ha.phase = "authenticating";
    console.log(`Connected to Home Assistant WebSocket proxy at ${HA_WS_URL}`);
    broadcastStatus();
  });

  ha.ws.on("message", (data) => {
    void handleHomeAssistantMessage(data);
  });

  ha.ws.on("close", (code, reason) => {
    const reasonText = reason?.toString() || "";
    ha.lastClose = {
      code,
      reason: reasonText,
      closedAt: new Date().toISOString(),
    };
    resetHaConnection(`WebSocket closed${code ? ` (${code})` : ""}${reasonText ? `: ${reasonText}` : ""}`);
    scheduleReconnect();
  });

  ha.ws.on("error", (error) => {
    console.error(`Home Assistant WebSocket error: ${error.message}`);
    resetHaConnection(error.message);
  });
}

async function handleHomeAssistantMessage(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }

  ha.lastMessageAt = new Date().toISOString();

  if (message.type === "auth_required") {
    ha.ws?.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
    return;
  }

  if (message.type === "auth_invalid") {
    console.error(`Home Assistant authentication failed: ${message.message || "Invalid token"}`);
    resetHaConnection(message.message || "Home Assistant authentication failed");
    return;
  }

  if (message.type === "auth_ok") {
    ha.authed = true;
    ha.lastError = null;
    ha.phase = "subscribing";
    await subscribeToWatchedEvents();
    ha.phase = "ready";
    broadcastStatus();
    return;
  }

  if (message.type === "result") {
    const pending = ha.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    ha.pending.delete(message.id);
    if (message.success) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error?.message || "Home Assistant command failed"));
    }
    return;
  }

  if (message.type === "event") {
    await handleHomeAssistantEvent(message.event);
  }
}

async function subscribeToWatchedEvents() {
  ha.watchedEventTypes = normalizeEventTypes(addonOptions.event_types);
  ha.subscriptions.clear();

  const subscriptionEventTypes = [...new Set([...ha.watchedEventTypes, "state_changed"])];

  for (const eventType of subscriptionEventTypes) {
    try {
      const id = ha.nextId++;
      await sendHaCommandWithId(id, { type: "subscribe_events", event_type: eventType });
      ha.subscriptions.set(id, eventType);
      console.log(`Subscribed to ${eventType}`);
    } catch (error) {
      ha.lastError = `Could not subscribe to ${eventType}: ${error.message}`;
      console.error(ha.lastError);
    }
  }
}

async function handleHomeAssistantEvent(event) {
  let followersChanged = false;
  if (event?.event_type === "state_changed") {
    cacheEntityState(event.data?.new_state);
    followersChanged = await syncStateFollowersForEvent(event);
  }

  const visibleEvent = ha.watchedEventTypes.includes(event?.event_type);
  if (!visibleEvent) {
    if (followersChanged) {
      await saveStore();
      broadcast({ type: "data", store, recentEvents });
    }
    return;
  }

  const signature = signatureFromEvent(event);
  recordRecentEvent(event, signature);

  if (learning && Date.now() <= learning.expiresAt) {
    const found = findBinding(learning.bindingId);
    if (found) {
      found.binding.trigger = signature;
      found.binding.lastLearnedAt = new Date().toISOString();
      learning = null;
      await saveStore();
      broadcast({ type: "learned", binding: found.binding, store, recentEvents });
      return;
    }
  }

  const matches = findMatchingBindings(event);
  for (const found of matches) {
    try {
      await callBindingAction(found.binding, "event");
    } catch (error) {
      found.binding.lastError = error.message;
      console.error(`Action failed for ${found.binding.name}: ${error.message}`);
    }
  }

  if (matches.length > 0 || followersChanged) {
    await saveStore();
    broadcast({ type: "data", store, recentEvents });
  } else {
    scheduleRecentEventsBroadcast();
  }
}

async function syncStateFollowersForEvent(event) {
  const sourceEntityId = cleanString(event?.data?.entity_id);
  if (!sourceEntityId) {
    return false;
  }

  const newState = event.data?.new_state?.state;
  const oldState = event.data?.old_state?.state;
  const newBinaryState = stateToBinary(newState);
  const oldBinaryState = stateToBinary(oldState);
  if (newBinaryState === null || newBinaryState === oldBinaryState) {
    return false;
  }

  const followers = store.followers.filter((follower) => (
    follower.enabled
    && follower.source_entity_id === sourceEntityId
    && follower.follower_entity_id
    && follower.follower_entity_id !== sourceEntityId
  ));

  const sourceWasRecentlyCommanded = wasEntityCommandedRecently(sourceEntityId);
  let changed = false;
  for (const follower of followers) {
    try {
      if (shouldSkipFollowerOnForGroup(follower, event.data?.new_state, newBinaryState, sourceWasRecentlyCommanded)) {
        recordFollowerSkip(follower, "Group source turned on without a recent Button Binder command");
        changed = true;
        continue;
      }

      await setFollowerState(follower, newBinaryState, "state_changed", newState);
      changed = true;
    } catch (error) {
      follower.lastError = error.message;
      changed = true;
      console.error(`State follower failed for ${follower.name}: ${error.message}`);
    }
  }

  if (sourceWasRecentlyCommanded) {
    recentlyCommandedEntities.delete(sourceEntityId);
  }

  return changed;
}

async function syncStateFollowerFromCurrentState(follower, source) {
  if (!follower.enabled) {
    throw new Error("State follower is disabled");
  }

  if (!follower.source_entity_id || !follower.follower_entity_id) {
    throw new Error("Source and follower entities are required");
  }

  if (follower.source_entity_id === follower.follower_entity_id) {
    throw new Error("Source and follower entities must be different");
  }

  const state = await getEntityState(follower.source_entity_id);
  const binaryState = stateToBinary(state?.state);
  if (binaryState === null) {
    throw new Error(`Source state '${state?.state ?? "unknown"}' cannot be mirrored`);
  }

  if (shouldSkipFollowerOnForGroup(follower, state, binaryState)) {
    recordFollowerSkip(follower, "Group source is on, but group-on behavior is protected");
    return;
  }

  await setFollowerState(follower, binaryState, source, state.state);
}

function shouldSkipFollowerOnForGroup(
  follower,
  sourceState,
  sourceBinaryState,
  sourceWasRecentlyCommanded = wasEntityCommandedRecently(follower.source_entity_id),
) {
  if (!sourceBinaryState || !isGroupLikeState(sourceState, follower.source_entity_id)) {
    return false;
  }

  const mode = follower.group_on_mode || "binder";
  if (mode === "always") {
    return false;
  }

  if (mode === "never") {
    return true;
  }

  return !sourceWasRecentlyCommanded;
}

function recordFollowerSkip(follower, reason) {
  follower.lastSkippedAt = new Date().toISOString();
  follower.lastSkipReason = reason;
  delete follower.lastError;
}

async function setFollowerState(follower, sourceBinaryState, source, sourceState) {
  const followerEntityId = cleanString(follower.follower_entity_id);
  const domain = followerEntityId.split(".")[0];
  const desiredOn = follower.invert ? !sourceBinaryState : sourceBinaryState;
  const service = desiredOn ? "turn_on" : "turn_off";

  if (!domain || !followerEntityId.includes(".")) {
    throw new Error("Follower entity must look like switch.name or light.name");
  }

  await sendHaCommand({
    type: "call_service",
    domain,
    service,
    target: { entity_id: followerEntityId },
    service_data: {},
  });

  follower.lastSyncedAt = new Date().toISOString();
  follower.lastSyncSource = source;
  follower.lastSourceState = sourceState;
  follower.lastFollowerCommand = `${domain}.${service}`;
  delete follower.lastError;
}

function findMatchingBindings(event) {
  const found = [];
  for (const iface of store.interfaces) {
    for (const button of iface.buttons) {
      for (const binding of button.bindings) {
        if (binding.enabled && binding.trigger && eventMatchesSignature(event, binding.trigger)) {
          found.push({ iface, button, binding });
        }
      }
    }
  }
  return found;
}

function eventMatchesSignature(event, trigger) {
  if (!event || event.event_type !== trigger.event_type) {
    return false;
  }

  const actual = signatureFromEvent(event);
  return isSubset(trigger.match, actual.match);
}

function signatureFromEvent(event) {
  const eventType = event?.event_type || "unknown";
  const data = event?.data || {};

  if (eventType === "state_changed") {
    return {
      event_type: eventType,
      match: removeUndefined({
        entity_id: data.entity_id,
        to: data.new_state?.state,
      }),
      preview: `${data.entity_id || "entity"} -> ${data.new_state?.state ?? "unknown"}`,
    };
  }

  if (eventType === "zha_event") {
    return {
      event_type: eventType,
      match: removeUndefined({
        device_id: data.device_id,
        unique_id: data.unique_id,
        endpoint_id: data.endpoint_id,
        cluster_id: data.cluster_id,
        command: data.command,
        args: stableValue(data.args),
        params: stableValue(data.params),
      }),
      preview: `ZHA ${data.command || "event"} ${data.endpoint_id ? `endpoint ${data.endpoint_id}` : ""}`.trim(),
    };
  }

  if (eventType === "deconz_event") {
    return {
      event_type: eventType,
      match: removeUndefined({
        id: data.id,
        device_id: data.device_id,
        event: data.event,
      }),
      preview: `deCONZ ${data.id || "device"} ${data.event ?? "event"}`,
    };
  }

  if (eventType === "zwave_js_value_notification") {
    return {
      event_type: eventType,
      match: removeUndefined({
        device_id: data.device_id,
        node_id: data.node_id,
        label: data.label,
        value: data.value,
        property_name: data.property_name,
      }),
      preview: `Z-Wave ${data.label || data.property_name || "event"} ${data.value ?? ""}`.trim(),
    };
  }

  return {
    event_type: eventType,
    match: stableValue(data),
    preview: eventType,
  };
}

async function callBindingAction(binding, source) {
  const action = normalizeAction(binding.action);
  if (!action.domain || !action.service) {
    throw new Error("Action is missing a domain or service");
  }

  const command = {
    type: "call_service",
    domain: action.domain,
    service: action.service,
    service_data: action.service_data || {},
  };

  if (action.target && Object.keys(removeEmpty(action.target)).length > 0) {
    command.target = removeEmpty(action.target);
  }

  markCommandedEntities(action);
  await sendHaCommand(command);
  binding.lastTriggeredAt = new Date().toISOString();
  binding.lastTriggerSource = source;
  delete binding.lastError;
}

function markCommandedEntities(action) {
  const entityIds = normalizeEntityIdArray(action?.target?.entity_id);
  for (const entityId of entityIds) {
    recentlyCommandedEntities.set(entityId, Date.now());
  }
}

function wasEntityCommandedRecently(entityId) {
  const lastCommandedAt = recentlyCommandedEntities.get(entityId);
  if (!lastCommandedAt) {
    return false;
  }

  const recent = Date.now() - lastCommandedAt <= RECENT_COMMAND_WINDOW_MS;
  if (!recent) {
    recentlyCommandedEntities.delete(entityId);
  }
  return recent;
}

async function getHaStates() {
  if (!(ha.connected && ha.authed)) {
    return ha.states;
  }

  const states = await sendHaCommand({ type: "get_states" });
  ha.states = states.map((state) => ({
    entity_id: state.entity_id,
    domain: state.entity_id.split(".")[0],
    name: state.attributes?.friendly_name || state.entity_id,
    state: state.state,
  }));
  for (const state of states) {
    cacheEntityState(state);
  }
  return ha.states;
}

async function getEntityState(entityId) {
  if (ha.stateByEntity.has(entityId)) {
    return ha.stateByEntity.get(entityId);
  }

  await getHaStates();
  return ha.stateByEntity.get(entityId);
}

function cacheEntityState(state) {
  if (state?.entity_id) {
    ha.stateByEntity.set(state.entity_id, state);
  }
}

async function getHaServices() {
  if (!(ha.connected && ha.authed)) {
    return ha.services || {};
  }

  ha.services = await sendHaCommand({ type: "get_services" });
  return ha.services;
}

function sendHaCommand(payload, timeoutMs = 10_000) {
  const id = ha.nextId++;
  return sendHaCommandWithId(id, payload, timeoutMs);
}

function sendHaCommandWithId(id, payload, timeoutMs = 10_000) {
  if (!(ha.ws && ha.ws.readyState === WebSocket.OPEN && ha.authed)) {
    return Promise.reject(new Error("Home Assistant WebSocket is not connected"));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ha.pending.delete(id);
      reject(new Error("Home Assistant command timed out"));
    }, timeoutMs);

    ha.pending.set(id, { resolve, reject, timeout });
    ha.ws.send(JSON.stringify({ id, ...payload }));
  });
}

function resetHaConnection(errorMessage) {
  ha.authed = false;
  ha.connected = false;
  ha.lastError = errorMessage;
  ha.phase = HA_TOKEN ? "offline" : "missing_token";
  for (const [id, pending] of ha.pending) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(errorMessage));
    ha.pending.delete(id);
  }
  broadcastStatus();
}

function scheduleReconnect() {
  if (!HA_TOKEN) {
    return;
  }

  clearTimeout(ha.reconnectTimer);
  ha.phase = "reconnecting";
  ha.reconnectTimer = setTimeout(connectHomeAssistant, 5000);
  broadcastStatus();
}

function recordRecentEvent(event, signature) {
  recentEvents.unshift({
    id: uid(),
    seenAt: new Date().toISOString(),
    event_type: event.event_type,
    preview: signature.preview,
    signature,
  });
  recentEvents = recentEvents.slice(0, MAX_RECENT_EVENTS);
}

function scheduleRecentEventsBroadcast() {
  if (recentEventBroadcastTimer) {
    return;
  }

  recentEventBroadcastTimer = setTimeout(() => {
    recentEventBroadcastTimer = null;
    broadcast({ type: "event", recentEvents });
  }, RECENT_EVENT_BROADCAST_INTERVAL_MS);
}

function expireLearningSession() {
  if (learning && Date.now() > learning.expiresAt) {
    learning = null;
    broadcast({ type: "learning", learning });
  }
}

function updateBinding(binding, patch) {
  if (patch.name !== undefined) {
    binding.name = cleanString(patch.name) || binding.name;
  }

  if (patch.enabled !== undefined) {
    binding.enabled = Boolean(patch.enabled);
  }

  if (patch.trigger !== undefined) {
    binding.trigger = patch.trigger || null;
  }

  if (patch.action !== undefined) {
    binding.action = normalizeAction(patch.action);
  }
}

function updateStateFollower(follower, patch) {
  if (patch.name !== undefined) {
    follower.name = cleanString(patch.name) || follower.name;
  }

  if (patch.binding_id !== undefined) {
    follower.binding_id = cleanString(patch.binding_id);
  }

  if (patch.enabled !== undefined) {
    follower.enabled = Boolean(patch.enabled);
  }

  if (patch.source_entity_id !== undefined) {
    follower.source_entity_id = cleanString(patch.source_entity_id);
  }

  if (patch.follower_entity_id !== undefined) {
    follower.follower_entity_id = cleanString(patch.follower_entity_id);
  }

  if (patch.group_on_mode !== undefined) {
    const mode = cleanString(patch.group_on_mode);
    follower.group_on_mode = ["always", "binder", "never"].includes(mode) ? mode : "binder";
  }

  if (patch.invert !== undefined) {
    follower.invert = Boolean(patch.invert);
  }
}

function normalizeAction(action = {}) {
  return {
    domain: cleanString(action.domain),
    service: cleanString(action.service),
    target: removeEmpty({
      entity_id: normalizeListOrString(action.target?.entity_id),
      device_id: normalizeListOrString(action.target?.device_id),
      area_id: normalizeListOrString(action.target?.area_id),
    }),
    service_data: action.service_data && typeof action.service_data === "object" ? action.service_data : {},
  };
}

function normalizeListOrString(value) {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }
  return cleanString(value);
}

function normalizeEntityIdArray(value) {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }

  const cleaned = cleanString(value);
  return cleaned ? [cleaned] : [];
}

function normalizeEventTypes(eventTypes) {
  const normalized = Array.isArray(eventTypes)
    ? eventTypes.map(cleanString).filter(Boolean)
    : DEFAULT_EVENT_TYPES;
  return [...new Set(normalized.length > 0 ? normalized : DEFAULT_EVENT_TYPES)];
}

function findInterface(interfaceId) {
  return store.interfaces.find((iface) => iface.id === interfaceId);
}

function findButton(buttonId) {
  for (const iface of store.interfaces) {
    const button = iface.buttons.find((item) => item.id === buttonId);
    if (button) {
      return { iface, button };
    }
  }
  return null;
}

function findBinding(bindingId) {
  for (const iface of store.interfaces) {
    for (const button of iface.buttons) {
      const binding = button.bindings.find((item) => item.id === bindingId);
      if (binding) {
        return { iface, button, binding };
      }
    }
  }
  return null;
}

function findStateFollower(followerId) {
  return store.followers.find((follower) => follower.id === followerId);
}

function broadcastStatus() {
  broadcast({
    type: "status",
    connected: ha.connected && ha.authed,
    lastClose: ha.lastClose,
    lastConnectedAt: ha.lastConnectedAt,
    lastError: ha.lastError,
    lastMessageAt: ha.lastMessageAt,
    phase: ha.phase,
    tokenPresent: Boolean(HA_TOKEN),
    watchedEventTypes: ha.watchedEventTypes,
  });
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const ws of clientSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function stateToBinary(state) {
  const value = cleanString(state).toLowerCase();
  if (["on", "open", "opening", "playing", "home", "heat", "cool"].includes(value)) {
    return true;
  }

  if (["off", "closed", "closing", "idle", "paused", "standby", "not_home"].includes(value)) {
    return false;
  }

  return null;
}

function isGroupLikeState(state, entityId) {
  if (cleanString(entityId).startsWith("group.")) {
    return true;
  }

  return Array.isArray(state?.attributes?.entity_id) && state.attributes.entity_id.length > 0;
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        const item = stableValue(value[key]);
        if (item !== undefined) {
          result[key] = item;
        }
        return result;
      }, {});
  }

  return value;
}

function removeUndefined(value) {
  return Object.entries(value).reduce((result, [key, item]) => {
    if (item !== undefined) {
      result[key] = item;
    }
    return result;
  }, {});
}

function removeEmpty(value) {
  return Object.entries(value).reduce((result, [key, item]) => {
    if (Array.isArray(item) && item.length > 0) {
      result[key] = item;
    } else if (typeof item === "string" && item.length > 0) {
      result[key] = item;
    } else if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length > 0) {
      result[key] = item;
    }
    return result;
  }, {});
}

function isSubset(expected, actual) {
  if (expected === actual) {
    return true;
  }

  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item, index) => isSubset(item, actual[index]));
  }

  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      return false;
    }

    return Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
  }

  return false;
}
