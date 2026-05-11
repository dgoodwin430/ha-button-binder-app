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
const HA_TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || "";
const DEFAULT_EVENT_TYPES = ["zha_event", "state_changed"];
const MAX_RECENT_EVENTS = 30;

let store = createDefaultStore();
let addonOptions = { event_types: DEFAULT_EVENT_TYPES };
let learning = null;
let recentEvents = [];
let clientSockets = new Set();

const ha = {
  authed: false,
  connected: false,
  lastError: null,
  nextId: 1,
  pending: new Map(),
  reconnectTimer: null,
  services: null,
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
    lastError: ha.lastError,
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
    version: 1,
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

  return {
    version: 1,
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
    console.warn("Home Assistant token is not available. Running UI only.");
    return;
  }

  clearTimeout(ha.reconnectTimer);
  ha.ws = new WebSocket(HA_WS_URL);
  ha.authed = false;
  ha.connected = false;
  ha.lastError = null;

  ha.ws.on("open", () => {
    ha.connected = true;
  });

  ha.ws.on("message", (data) => {
    void handleHomeAssistantMessage(data);
  });

  ha.ws.on("close", () => {
    resetHaConnection("WebSocket closed");
    scheduleReconnect();
  });

  ha.ws.on("error", (error) => {
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

  if (message.type === "auth_required") {
    ha.ws?.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
    return;
  }

  if (message.type === "auth_invalid") {
    resetHaConnection(message.message || "Home Assistant authentication failed");
    return;
  }

  if (message.type === "auth_ok") {
    ha.authed = true;
    ha.lastError = null;
    await subscribeToWatchedEvents();
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

  for (const eventType of ha.watchedEventTypes) {
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

  if (matches.length > 0) {
    await saveStore();
    broadcast({ type: "data", store, recentEvents });
  } else {
    broadcast({ type: "event", recentEvents });
  }
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

  await sendHaCommand(command);
  binding.lastTriggeredAt = new Date().toISOString();
  binding.lastTriggerSource = source;
  delete binding.lastError;
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
  return ha.states;
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
  ha.reconnectTimer = setTimeout(connectHomeAssistant, 5000);
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

function broadcastStatus() {
  broadcast({
    type: "status",
    connected: ha.connected && ha.authed,
    lastError: ha.lastError,
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
