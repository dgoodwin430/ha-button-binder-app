const state = {
  data: { store: { followers: [], interfaces: [] }, recentEvents: [], learning: null },
  entities: [],
  eventsPaused: false,
  services: {},
  status: { connected: false, lastError: null, watchedEventTypes: [] },
};

const els = {
  addFollowerButton: document.querySelector("#addFollowerButton"),
  addInterfaceButton: document.querySelector("#addInterfaceButton"),
  clearEventsButton: document.querySelector("#clearEventsButton"),
  eventCount: document.querySelector("#eventCount"),
  followers: document.querySelector("#followers"),
  interfaces: document.querySelector("#interfaces"),
  newButtonCount: document.querySelector("#newButtonCount"),
  newInterfaceName: document.querySelector("#newInterfaceName"),
  notice: document.querySelector("#notice"),
  pauseEventsButton: document.querySelector("#pauseEventsButton"),
  recentEvents: document.querySelector("#recentEvents"),
  refreshButton: document.querySelector("#refreshButton"),
  statusLine: document.querySelector("#statusLine"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  syncFollowersButton: document.querySelector("#syncFollowersButton"),
  entityList: document.querySelector("#entityList"),
};

els.addFollowerButton.addEventListener("click", addFollower);
els.addInterfaceButton.addEventListener("click", addInterface);
els.clearEventsButton.addEventListener("click", clearEvents);
els.pauseEventsButton.addEventListener("click", toggleEventsPaused);
els.refreshButton.addEventListener("click", refreshAll);
els.syncFollowersButton.addEventListener("click", syncFollowers);

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
  renderFollowers();
  renderEvents();
}

function renderStatus() {
  els.statusPill.classList.toggle("connected", Boolean(state.status.connected));
  els.statusText.textContent = state.status.connected ? "Connected" : "Offline";

  const eventTypes = state.status.watchedEventTypes?.length
    ? state.status.watchedEventTypes.join(", ")
    : "no events";
  const learning = state.data.learning ? "Learning" : "Ready";
  const detail = state.status.connected ? `Watching ${eventTypes}` : statusDetail();
  els.statusLine.textContent = `${learning} | ${detail}`;
}

function statusDetail() {
  if (!state.status.tokenPresent) {
    return "Missing SUPERVISOR_TOKEN";
  }

  if (state.status.lastError) {
    return state.status.lastError;
  }

  if (state.status.phase) {
    return `Connection phase: ${state.status.phase}`;
  }

  return "Waiting for Home Assistant";
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
  const linkedFollower = findLinkedFollower(binding.id);
  const actionEntity = firstEntityId(action.target?.entity_id);
  const followerSource = linkedFollower?.source_entity_id || actionEntity;
  const followerEnabled = Boolean(linkedFollower?.enabled);
  const followerLast = linkedFollower?.lastSyncedAt ? `Last: ${formatTime(linkedFollower.lastSyncedAt)}` : "Last: never";
  const followerCommand = linkedFollower?.lastFollowerCommand ? `Command: ${linkedFollower.lastFollowerCommand}` : "";
  const followerSkipped = linkedFollower?.lastSkipReason ? `Skipped: ${linkedFollower.lastSkipReason}` : "";
  const followerError = linkedFollower?.lastError ? `<strong>${escapeHtml(linkedFollower.lastError)}</strong>` : "";
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
      <div class="indicator-panel" data-linked-follower-id="${escapeAttr(linkedFollower?.id || "")}">
        <div class="indicator-title">
          <label class="check-label">
            <input data-linked-follower-enabled type="checkbox" ${followerEnabled ? "checked" : ""}>
            Sync indicator
          </label>
          <button data-sync-linked-follower class="secondary small" type="button" ${linkedFollower && followerEnabled ? "" : "disabled"}>Sync</button>
        </div>
        <div class="indicator-grid">
          <label>
            Source
            <input data-linked-follower-source list="entityList" type="text" value="${escapeAttr(followerSource || "")}">
          </label>
          <label>
            Indicator entity
            <input data-linked-follower-target list="entityList" type="text" value="${escapeAttr(linkedFollower?.follower_entity_id || "")}">
          </label>
          <label>
            Group on
            <select data-linked-follower-group-on>${renderGroupOnModeOptions(linkedFollower?.group_on_mode)}</select>
          </label>
          <label class="check-label">
            <input data-linked-follower-invert type="checkbox" ${linkedFollower?.invert ? "checked" : ""}>
            Invert
          </label>
        </div>
        <div class="binding-meta">
          <span>${escapeHtml(followerLast)}</span>
          ${followerCommand ? `<span>${escapeHtml(followerCommand)}</span>` : ""}
          ${followerSkipped ? `<span>${escapeHtml(followerSkipped)}</span>` : ""}
          ${followerError}
        </div>
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
  els.eventCount.textContent = state.eventsPaused ? `${events.length} paused` : String(events.length);
  els.pauseEventsButton.textContent = state.eventsPaused ? "Resume" : "Pause";
  els.pauseEventsButton.classList.toggle("active", state.eventsPaused);
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

function renderFollowers() {
  const followers = state.data.store.followers || [];
  if (followers.length === 0) {
    els.followers.innerHTML = '<div class="empty compact">No state followers yet</div>';
    return;
  }

  els.followers.innerHTML = followers.map(renderFollower).join("");
  bindFollowerEvents();
}

function renderFollower(follower) {
  const last = follower.lastSyncedAt ? `Last: ${formatTime(follower.lastSyncedAt)}` : "Last: never";
  const command = follower.lastFollowerCommand ? `Command: ${follower.lastFollowerCommand}` : "";
  const skipped = follower.lastSkipReason ? `Skipped: ${follower.lastSkipReason}` : "";
  const error = follower.lastError ? `<strong>${escapeHtml(follower.lastError)}</strong>` : "";
  const linked = follower.binding_id ? "Linked to binding" : "";

  return `
    <div class="follower-row" data-follower-id="${escapeAttr(follower.id)}">
      <label>
        Name
        <input data-follower-name type="text" value="${escapeAttr(follower.name)}">
      </label>
      <label>
        Source entity
        <input data-follower-source list="entityList" type="text" value="${escapeAttr(follower.source_entity_id || "")}">
      </label>
      <label>
        Follower entity
        <input data-follower-target list="entityList" type="text" value="${escapeAttr(follower.follower_entity_id || "")}">
      </label>
      <label>
        Group on
        <select data-follower-group-on>${renderGroupOnModeOptions(follower.group_on_mode)}</select>
      </label>
      <label class="check-label">
        <input data-follower-enabled type="checkbox" ${follower.enabled ? "checked" : ""}>
        Enabled
      </label>
      <label class="check-label">
        <input data-follower-invert type="checkbox" ${follower.invert ? "checked" : ""}>
        Invert
      </label>
      <div class="follower-actions">
        <button data-save-follower class="small" type="button">Save</button>
        <button data-sync-follower class="secondary small" type="button">Sync</button>
        <button data-delete-follower class="danger small" type="button">Delete</button>
      </div>
      <div class="binding-meta">
        ${linked ? `<span>${escapeHtml(linked)}</span>` : ""}
        <span>${escapeHtml(last)}</span>
        ${command ? `<span>${escapeHtml(command)}</span>` : ""}
        ${skipped ? `<span>${escapeHtml(skipped)}</span>` : ""}
        ${error}
      </div>
    </div>
  `;
}

function renderGroupOnModeOptions(selectedMode = "binder") {
  selectedMode = selectedMode || "binder";
  const modes = [
    ["binder", "After app command"],
    ["always", "Always"],
    ["never", "Never"],
  ];
  return modes.map(([value, label]) => option(value, label, value === selectedMode)).join("");
}

function findLinkedFollower(bindingId) {
  return (state.data.store.followers || []).find((follower) => follower.binding_id === bindingId);
}

function firstEntityId(value) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return typeof value === "string" ? value.trim() : "";
}

async function clearEvents() {
  state.data.recentEvents = [];
  renderEvents();
  await request("api/events/clear", { method: "POST" });
}

function toggleEventsPaused() {
  state.eventsPaused = !state.eventsPaused;
  renderEvents();
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

  document.querySelectorAll("[data-sync-linked-follower]").forEach((button) => {
    button.addEventListener("click", () => syncLinkedFollower(button.closest("[data-binding-id]")));
  });

  document.querySelectorAll("[data-action-domain]").forEach((select) => {
    select.addEventListener("change", () => {
      const binding = select.closest("[data-binding-id]");
      const serviceSelect = binding.querySelector("[data-action-service]");
      serviceSelect.innerHTML = renderServiceOptions(select.value, "");
    });
  });
}

function bindFollowerEvents() {
  document.querySelectorAll("[data-save-follower]").forEach((button) => {
    button.addEventListener("click", () => saveFollower(button.closest("[data-follower-id]")));
  });

  document.querySelectorAll("[data-sync-follower]").forEach((button) => {
    button.addEventListener("click", () => syncFollower(button.closest("[data-follower-id]")));
  });

  document.querySelectorAll("[data-delete-follower]").forEach((button) => {
    button.addEventListener("click", () => deleteFollower(button.closest("[data-follower-id]")));
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

async function addFollower() {
  await request("api/followers", {
    method: "POST",
    body: { name: "State follower" },
  });
  await refreshData();
  render();
}

async function saveFollower(element) {
  await request(`api/followers/${element.dataset.followerId}`, {
    method: "PATCH",
    body: followerPayload(element),
  });
  await refreshData();
  render();
}

async function syncFollower(element) {
  await saveFollower(element);
  await request(`api/followers/${element.dataset.followerId}/sync`, { method: "POST" });
  await refreshData();
  render();
}

async function syncFollowers() {
  await request("api/followers/sync", { method: "POST" });
  await refreshData();
  render();
}

async function deleteFollower(element) {
  if (!confirm("Delete this state follower?")) {
    return;
  }

  await request(`api/followers/${element.dataset.followerId}`, { method: "DELETE" });
  await refreshData();
  render();
}

function followerPayload(element) {
  return {
    name: element.querySelector("[data-follower-name]").value,
    enabled: element.querySelector("[data-follower-enabled]").checked,
    invert: element.querySelector("[data-follower-invert]").checked,
    group_on_mode: element.querySelector("[data-follower-group-on]").value,
    source_entity_id: element.querySelector("[data-follower-source]").value.trim(),
    follower_entity_id: element.querySelector("[data-follower-target]").value.trim(),
  };
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

  const action = {
    domain: element.querySelector("[data-action-domain]").value,
    service: element.querySelector("[data-action-service]").value,
    target: {
      entity_id: element.querySelector("[data-action-entity]").value.trim(),
    },
    service_data: serviceData,
  };
  const followerPatch = linkedFollowerPayload(element, bindingId, action);
  if (followerPatch.enabled && !followerPatch.follower_entity_id) {
    showNotice("Choose an indicator entity before enabling Sync indicator.");
    return;
  }
  if (followerPatch.enabled && !followerPatch.source_entity_id) {
    showNotice("Choose a source entity before enabling Sync indicator.");
    return;
  }

  await request(`api/bindings/${bindingId}`, {
    method: "PATCH",
    body: {
      name: element.querySelector("[data-binding-name]").value,
      enabled: element.querySelector("[data-binding-enabled]").checked,
      action,
    },
  });
  await saveLinkedFollower(element, followerPatch);
  await refreshData();
  render();
}

async function saveLinkedFollower(element, followerPatch) {
  const followerId = element.querySelector("[data-linked-follower-id]")?.dataset.linkedFollowerId;
  const hasUsefulFields = followerPatch.enabled || followerPatch.follower_entity_id;

  if (!followerId && !hasUsefulFields) {
    return;
  }

  if (followerId) {
    await request(`api/followers/${followerId}`, {
      method: "PATCH",
      body: followerPatch,
    });
    return;
  }

  await request("api/followers", {
    method: "POST",
    body: followerPatch,
  });
}

async function syncLinkedFollower(element) {
  await saveBinding(element);
  const follower = findLinkedFollower(element.dataset.bindingId);
  if (!follower) {
    showNotice("Save the binding before syncing the indicator.");
    return;
  }

  await request(`api/followers/${follower.id}/sync`, { method: "POST" });
  await refreshData();
  render();
}

function linkedFollowerPayload(element, bindingId, action) {
  const source = element.querySelector("[data-linked-follower-source]").value.trim()
    || firstEntityId(action.target?.entity_id);

  return {
    binding_id: bindingId,
    name: `${element.querySelector("[data-binding-name]").value || "Binding"} indicator`,
    enabled: element.querySelector("[data-linked-follower-enabled]").checked,
    invert: element.querySelector("[data-linked-follower-invert]").checked,
    group_on_mode: element.querySelector("[data-linked-follower-group-on]").value,
    source_entity_id: source,
    follower_entity_id: element.querySelector("[data-linked-follower-target]").value.trim(),
  };
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
    let renderAll = false;
    let renderEventList = false;
    let renderStatusOnly = false;

    if (payload.store) {
      state.data.store = payload.store;
      renderAll = true;
    }
    if (payload.learning !== undefined) {
      state.data.learning = payload.learning;
      renderAll = true;
    }
    if (payload.recentEvents) {
      if (!(state.eventsPaused && payload.type === "event")) {
        state.data.recentEvents = payload.recentEvents;
        renderEventList = true;
      }
    }
    if (payload.connected !== undefined) {
      state.status.connected = payload.connected;
      state.status.lastError = payload.lastError;
      state.status.watchedEventTypes = payload.watchedEventTypes || [];
      state.status.phase = payload.phase;
      state.status.tokenPresent = payload.tokenPresent;
      state.status.lastClose = payload.lastClose;
      state.status.lastConnectedAt = payload.lastConnectedAt;
      state.status.lastMessageAt = payload.lastMessageAt;
      renderStatusOnly = true;
    }

    if (renderAll) {
      render();
    } else if (renderEventList) {
      renderEvents();
    } else if (renderStatusOnly) {
      renderStatus();
    }
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
