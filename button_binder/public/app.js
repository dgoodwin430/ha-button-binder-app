const state = {
  data: { store: { interfaces: [] }, recentEvents: [], learning: null },
  entities: [],
  services: {},
  status: { connected: false, lastError: null, watchedEventTypes: [] },
};

const els = {
  addInterfaceButton: document.querySelector("#addInterfaceButton"),
  eventCount: document.querySelector("#eventCount"),
  interfaces: document.querySelector("#interfaces"),
  newButtonCount: document.querySelector("#newButtonCount"),
  newInterfaceName: document.querySelector("#newInterfaceName"),
  notice: document.querySelector("#notice"),
  recentEvents: document.querySelector("#recentEvents"),
  refreshButton: document.querySelector("#refreshButton"),
  statusLine: document.querySelector("#statusLine"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  entityList: document.querySelector("#entityList"),
};

els.addInterfaceButton.addEventListener("click", addInterface);
els.refreshButton.addEventListener("click", refreshAll);

connectEvents();
await refreshAll();
setInterval(refreshStatus, 5000);

async function refreshAll() {
  await Promise.all([refreshData(), refreshStatus(), refreshHaMeta()]);
  render();
}

async function refreshData() {
  state.data = await request("api/data");
}

async function refreshStatus() {
  try {
    state.status = await request("api/status");
    renderStatus();
  } catch (error) {
    showNotice(error.message);
  }
}

async function refreshHaMeta() {
  try {
    const [entities, services] = await Promise.all([
      request("api/ha/entities"),
      request("api/ha/services"),
    ]);
    state.entities = entities;
    state.services = services;
    renderEntityList();
  } catch {
    state.entities = [];
    state.services = {};
  }
}

async function addInterface() {
  const name = els.newInterfaceName.value.trim() || "Zemismart 4 Button Remote";
  const buttonCount = Number(els.newButtonCount.value || 4);
  await request("api/interfaces", {
    method: "POST",
    body: { name, buttonCount },
  });
  await refreshData();
  render();
}

function render() {
  renderStatus();
  renderInterfaces();
  renderEvents();
}

function renderStatus() {
  els.statusPill.classList.toggle("connected", Boolean(state.status.connected));
  els.statusText.textContent = state.status.connected ? "Connected" : "Offline";

  const eventTypes = state.status.watchedEventTypes?.length
    ? state.status.watchedEventTypes.join(", ")
    : "no events";
  const learning = state.data.learning ? "Learning" : "Ready";
  const detail = state.status.connected ? `Watching ${eventTypes}` : state.status.lastError || "Waiting for Home Assistant";
  els.statusLine.textContent = `${learning} | ${detail}`;
}

function renderInterfaces() {
  const interfaces = state.data.store.interfaces || [];
  if (interfaces.length === 0) {
    els.interfaces.innerHTML = '<div class="empty">No button interfaces yet</div>';
    return;
  }

  els.interfaces.innerHTML = interfaces.map(renderInterface).join("");
  bindInterfaceEvents();
}

function renderInterface(iface) {
  return `
    <section class="interface" data-interface-id="${escapeAttr(iface.id)}">
      <div class="interface-header">
        <label>
          Interface
          <input data-interface-name type="text" value="${escapeAttr(iface.name)}">
        </label>
        <button data-save-interface type="button">Save</button>
        <button data-delete-interface class="danger" type="button">Delete</button>
      </div>
      <div class="button-grid">
        ${iface.buttons.map((button) => renderButton(button)).join("")}
      </div>
    </section>
  `;
}

function renderButton(button) {
  return `
    <article class="button-panel" data-button-id="${escapeAttr(button.id)}">
      <div class="button-header">
        <label>
          Button
          <input data-button-label type="text" value="${escapeAttr(button.label)}">
        </label>
        <button data-save-button class="secondary small" type="button">Save</button>
        <button data-add-binding class="small" type="button">Add Binding</button>
      </div>
      <div class="bindings">
        ${button.bindings.map((binding) => renderBinding(binding)).join("")}
      </div>
    </article>
  `;
}

function renderBinding(binding) {
  const action = binding.action || {};
  const trigger = binding.trigger ? formatTrigger(binding.trigger) : "No trigger learned";
  const isLearning = state.data.learning?.bindingId === binding.id;
  const serviceData = JSON.stringify(action.service_data || {}, null, 2);
  const last = binding.lastTriggeredAt ? `Last: ${formatTime(binding.lastTriggeredAt)}` : "Last: never";
  const error = binding.lastError ? `<strong>${escapeHtml(binding.lastError)}</strong>` : "";

  return `
    <div class="binding ${isLearning ? "learning" : ""}" data-binding-id="${escapeAttr(binding.id)}">
      <div class="binding-title">
        <label>
          Binding
          <input data-binding-name type="text" value="${escapeAttr(binding.name)}">
        </label>
        <label class="check-label">
          <input data-binding-enabled type="checkbox" ${binding.enabled ? "checked" : ""}>
          Enabled
        </label>
        <button data-learn class="small" type="button">${isLearning ? "Learning" : "Learn"}</button>
        <button data-test class="secondary small" type="button">Test</button>
        <button data-delete-binding class="danger small" type="button">Delete</button>
      </div>
      <div class="trigger-line">
        <span class="tag">Trigger</span>
        <code title="${escapeAttr(trigger)}">${escapeHtml(trigger)}</code>
      </div>
      <div class="action-grid">
        <label>
          Domain
          <select data-action-domain>${renderDomainOptions(action.domain)}</select>
        </label>
        <label>
          Service
          <select data-action-service>${renderServiceOptions(action.domain, action.service)}</select>
        </label>
        <label>
          Entity
          <input data-action-entity list="entityList" type="text" value="${escapeAttr(action.target?.entity_id || "")}">
        </label>
        <label class="data-field">
          Data
          <textarea data-service-data spellcheck="false">${escapeHtml(serviceData)}</textarea>
        </label>
      </div>
      <div class="binding-meta">
        <span>${escapeHtml(last)}</span>
        ${error}
      </div>
      <button data-save-binding type="button">Save Binding</button>
    </div>
  `;
}

function renderEvents() {
  const events = state.data.recentEvents || [];
  els.eventCount.textContent = String(events.length);
  if (events.length === 0) {
    els.recentEvents.innerHTML = '<li><span>No events captured</span><span></span><code></code></li>';
    return;
  }

  els.recentEvents.innerHTML = events.map((event) => `
    <li>
      <time>${escapeHtml(formatTime(event.seenAt))}</time>
      <span><b>${escapeHtml(event.event_type)}</b> ${escapeHtml(event.preview || "")}</span>
      <code title="${escapeAttr(JSON.stringify(event.signature.match))}">${escapeHtml(shortJson(event.signature.match))}</code>
    </li>
  `).join("");
}

function renderEntityList() {
  els.entityList.innerHTML = state.entities
    .map((entity) => `<option value="${escapeAttr(entity.entity_id)}">${escapeHtml(entity.name)}</option>`)
    .join("");
}

function renderDomainOptions(selectedDomain = "light") {
  const serviceDomains = Object.keys(state.services);
  const entityDomains = [...new Set(state.entities.map((entity) => entity.domain))];
  const domains = [...new Set([...serviceDomains, ...entityDomains, "light", "switch", "scene", "script"])]
    .filter(Boolean)
    .sort();
  const selected = selectedDomain || domains[0] || "light";
  return domains.map((domain) => option(domain, domain, domain === selected)).join("");
}

function renderServiceOptions(domain, selectedService) {
  const services = Object.keys(state.services?.[domain] || {});
  const fallback = commonServices(domain);
  const serviceNames = [...new Set([...services, ...fallback])].filter(Boolean).sort();
  const selected = selectedService || serviceNames[0] || "toggle";
  return serviceNames.map((service) => option(service, service, service === selected)).join("");
}

function commonServices(domain) {
  if (domain === "scene") {
    return ["turn_on"];
  }
  if (domain === "script") {
    return ["turn_on"];
  }
  if (domain === "cover") {
    return ["open_cover", "close_cover", "stop_cover"];
  }
  if (domain === "media_player") {
    return ["media_play_pause", "volume_up", "volume_down"];
  }
  return ["toggle", "turn_on", "turn_off"];
}

function bindInterfaceEvents() {
  document.querySelectorAll("[data-save-interface]").forEach((button) => {
    button.addEventListener("click", () => saveInterface(button.closest("[data-interface-id]")));
  });

  document.querySelectorAll("[data-delete-interface]").forEach((button) => {
    button.addEventListener("click", () => deleteInterface(button.closest("[data-interface-id]")));
  });

  document.querySelectorAll("[data-save-button]").forEach((button) => {
    button.addEventListener("click", () => saveButton(button.closest("[data-button-id]")));
  });

  document.querySelectorAll("[data-add-binding]").forEach((button) => {
    button.addEventListener("click", () => addBinding(button.closest("[data-button-id]")));
  });

  document.querySelectorAll("[data-save-binding]").forEach((button) => {
    button.addEventListener("click", () => saveBinding(button.closest("[data-binding-id]")));
  });

  document.querySelectorAll("[data-delete-binding]").forEach((button) => {
    button.addEventListener("click", () => deleteBinding(button.closest("[data-binding-id]")));
  });

  document.querySelectorAll("[data-learn]").forEach((button) => {
    button.addEventListener("click", () => learnBinding(button.closest("[data-binding-id]")));
  });

  document.querySelectorAll("[data-test]").forEach((button) => {
    button.addEventListener("click", () => testBinding(button.closest("[data-binding-id]")));
  });

  document.querySelectorAll("[data-action-domain]").forEach((select) => {
    select.addEventListener("change", () => {
      const binding = select.closest("[data-binding-id]");
      const serviceSelect = binding.querySelector("[data-action-service]");
      serviceSelect.innerHTML = renderServiceOptions(select.value, "");
    });
  });
}

async function saveInterface(element) {
  const interfaceId = element.dataset.interfaceId;
  const name = element.querySelector("[data-interface-name]").value;
  await request(`api/interfaces/${interfaceId}`, {
    method: "PATCH",
    body: { name },
  });
  await refreshData();
  render();
}

async function deleteInterface(element) {
  if (!confirm("Delete this interface?")) {
    return;
  }

  await request(`api/interfaces/${element.dataset.interfaceId}`, { method: "DELETE" });
  await refreshData();
  render();
}

async function saveButton(element) {
  const buttonId = element.dataset.buttonId;
  const label = element.querySelector("[data-button-label]").value;
  await request(`api/buttons/${buttonId}`, {
    method: "PATCH",
    body: { label },
  });
  await refreshData();
  render();
}

async function addBinding(element) {
  await request(`api/buttons/${element.dataset.buttonId}/bindings`, {
    method: "POST",
    body: { name: "Press" },
  });
  await refreshData();
  render();
}

async function saveBinding(element) {
  const bindingId = element.dataset.bindingId;
  let serviceData;
  try {
    serviceData = JSON.parse(element.querySelector("[data-service-data]").value || "{}");
  } catch {
    showNotice("Data must be valid JSON.");
    return;
  }

  await request(`api/bindings/${bindingId}`, {
    method: "PATCH",
    body: {
      name: element.querySelector("[data-binding-name]").value,
      enabled: element.querySelector("[data-binding-enabled]").checked,
      action: {
        domain: element.querySelector("[data-action-domain]").value,
        service: element.querySelector("[data-action-service]").value,
        target: {
          entity_id: element.querySelector("[data-action-entity]").value.trim(),
        },
        service_data: serviceData,
      },
    },
  });
  await refreshData();
  render();
}

async function deleteBinding(element) {
  if (!confirm("Delete this binding?")) {
    return;
  }

  await request(`api/bindings/${element.dataset.bindingId}`, { method: "DELETE" });
  await refreshData();
  render();
}

async function learnBinding(element) {
  await request(`api/bindings/${element.dataset.bindingId}/learn`, { method: "POST" });
  await refreshData();
  render();
}

async function testBinding(element) {
  await request(`api/bindings/${element.dataset.bindingId}/test`, { method: "POST" });
  await refreshData();
  render();
}

function connectEvents() {
  const url = new URL("events", document.baseURI);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);

  ws.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.store) {
      state.data.store = payload.store;
    }
    if (payload.learning !== undefined) {
      state.data.learning = payload.learning;
    }
    if (payload.recentEvents) {
      state.data.recentEvents = payload.recentEvents;
    }
    if (payload.connected !== undefined) {
      state.status.connected = payload.connected;
      state.status.lastError = payload.lastError;
      state.status.watchedEventTypes = payload.watchedEventTypes || [];
    }
    render();
  });

  ws.addEventListener("close", () => {
    setTimeout(connectEvents, 3000);
  });
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, document.baseURI), {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function option(value, label, selected) {
  return `<option value="${escapeAttr(value)}" ${selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function formatTrigger(trigger) {
  return `${trigger.event_type}: ${shortJson(trigger.match)}`;
}

function shortJson(value) {
  const text = JSON.stringify(value || {});
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
  setTimeout(() => {
    els.notice.hidden = true;
  }, 5000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
