const urlState = new URL(window.location.href);

const state = {
  token: urlState.searchParams.get("token") || localStorage.getItem("codexRelayToken") || "",
  threads: [],
  jobs: [],
  settings: null,
  selectedThreadId: null,
  selectedThread: null,
  requestedThreadId: urlState.searchParams.get("thread") || "",
  pendingNewJobId: "",
  optimisticMessages: [],
  pendingImages: [],
  searchText: "",
  eventSource: null,
  activeLayoutTab: "conversation",
  activeUtilityTab: "alerts",
  pairing: null
};

const loginCard = document.querySelector("#login-card");
const appShell = document.querySelector("#app");
const loginForm = document.querySelector("#login-form");
const tokenInput = document.querySelector("#token-input");
const loginError = document.querySelector("#login-error");
const pairingEntry = document.querySelector("#pairing-entry");
const threadList = document.querySelector("#thread-list");
const threadTitle = document.querySelector("#thread-title");
const threadMeta = document.querySelector("#thread-meta");
const messageList = document.querySelector("#message-list");
const newThreadButton = document.querySelector("#new-thread-button");
const settingsWorkspace = document.querySelector("#settings-workspace");
const promptInput = document.querySelector("#prompt-input");
const imageInput = document.querySelector("#image-input");
const attachmentList = document.querySelector("#attachment-list");
const composerForm = document.querySelector("#composer-form");
const composerTarget = document.querySelector("#composer-target");
const composerHint = document.querySelector("#composer-hint");
const statusStrip = document.querySelector("#status-strip");
const layoutTabs = document.querySelector("#layout-tabs");
const layoutPanels = Array.from(document.querySelectorAll("[data-panel]"));
const threadSearch = document.querySelector("#thread-search");
const refreshButton = document.querySelector("#refresh-button");
const settingsButton = document.querySelector("#settings-button");
const accessSettingsButton = document.querySelector("#access-settings-button");
const utilityTabs = document.querySelector("#utility-tabs");
const utilityViews = Array.from(document.querySelectorAll("[data-utility-view]"));
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");
const publicBaseUrlInput = document.querySelector("#public-base-url");
const webhookInput = document.querySelector("#webhook-input");
const botTokenInput = document.querySelector("#bot-token-input");
const botTokenStatus = document.querySelector("#bot-token-status");
const channelIdInput = document.querySelector("#channel-id-input");
const notifyToggle = document.querySelector("#notify-toggle");
const settingsHint = document.querySelector("#settings-hint");
const closeSettingsButton = document.querySelector("#close-settings");
const summaryWorkspace = document.querySelector("#summary-workspace");
const summaryPublicUrl = document.querySelector("#summary-public-url");
const summaryAlertStatus = document.querySelector("#summary-alert-status");
const summaryDeliveryMode = document.querySelector("#summary-delivery-mode");
const pairingRemoteNote = document.querySelector("#pairing-remote-note");
const pairingLocalPanel = document.querySelector("#pairing-local-panel");
const pairTokenInline = document.querySelector("#pair-token-inline");
const copyTokenInlineButton = document.querySelector("#copy-token-inline");
const regenerateTokenInlineButton = document.querySelector("#regenerate-token-inline");
const pairLinksInline = document.querySelector("#pair-links-inline");
const pairStatusInline = document.querySelector("#pair-status-inline");
const MAX_PENDING_IMAGES = 4;
const MAX_PENDING_IMAGE_BYTES = 10 * 1024 * 1024;

function apiFetch(route, options = {}) {
  return fetch(route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Request failed");
    }
    return payload;
  });
}

function plainFetch(route, options = {}) {
  return fetch(route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Request failed");
    }
    return payload;
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "absolute";
  fallback.style.left = "-9999px";
  document.body.appendChild(fallback);
  fallback.select();
  document.execCommand("copy");
  fallback.remove();
}

function createClientId() {
  return window.crypto?.randomUUID?.() || `image_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 * 1024) {
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name || "image"}.`));
    reader.readAsDataURL(file);
  });
}

function setLoggedIn(isLoggedIn) {
  loginCard.classList.toggle("hidden", isLoggedIn);
  appShell.classList.toggle("hidden", !isLoggedIn);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function relativeTime(value) {
  if (!value) {
    return "";
  }

  const deltaMinutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (Math.abs(deltaMinutes) < 1) {
    return "just now";
  }
  if (Math.abs(deltaMinutes) < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return `${deltaHours}h ago`;
  }
  return `${Math.round(deltaHours / 24)}d ago`;
}

function isLocalBrowser() {
  const host = window.location.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isCompactLayout() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function setLayoutTab(tab) {
  state.activeLayoutTab = tab;

  document.querySelectorAll("[data-layout-tab]").forEach((button) => {
    const active = button.dataset.layoutTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  layoutPanels.forEach((panel) => {
    panel.classList.toggle("panel-mobile-hidden", isCompactLayout() && panel.dataset.panel !== tab);
  });
}

function setUtilityTab(tab) {
  state.activeUtilityTab = tab;

  document.querySelectorAll("[data-utility-tab]").forEach((button) => {
    const active = button.dataset.utilityTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  utilityViews.forEach((view) => {
    view.classList.toggle("hidden", view.dataset.utilityView !== tab);
  });

  if (tab === "pairing") {
    void ensurePairingLoaded();
  }
}

function updateUrl(threadId) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("token");
  if (threadId) {
    nextUrl.searchParams.set("thread", threadId);
  } else {
    nextUrl.searchParams.delete("thread");
  }
  history.replaceState({}, "", nextUrl);
}

function clearTokenFromUrl() {
  const nextUrl = new URL(window.location.href);
  if (!nextUrl.searchParams.has("token")) {
    return;
  }
  nextUrl.searchParams.delete("token");
  history.replaceState({}, "", nextUrl);
}

function applySettingsToDialog() {
  if (!state.settings) {
    return;
  }
  settingsWorkspace.value = state.settings.defaultWorkspaceRoot || "";
  publicBaseUrlInput.value = state.settings.publicBaseUrl || "";
  webhookInput.value = state.settings.discordWebhookUrl || "";
  channelIdInput.value = state.settings.discordChannelId || "";
  botTokenInput.value = "";
  botTokenStatus.textContent = state.settings.discordBotTokenConfigured
    ? "Bot token is stored. Leave the field blank to keep it."
    : "No bot token is stored yet.";
  notifyToggle.checked = Boolean(state.settings.notificationEnabled);
  settingsHint.textContent = "";
}

function renderSettingsSummary() {
  if (!state.settings) {
    return;
  }

  summaryWorkspace.textContent = state.settings.defaultWorkspaceRoot || "Not set";
  summaryPublicUrl.textContent = state.settings.publicBaseUrl || "Not configured";
  summaryAlertStatus.textContent = state.settings.notificationEnabled ? "Enabled" : "Disabled";

  if (state.settings.discordBotTokenConfigured && state.settings.discordChannelId) {
    summaryDeliveryMode.textContent = "Discord bot";
    return;
  }

  if (state.settings.discordWebhookConfigured) {
    summaryDeliveryMode.textContent = "Webhook";
    return;
  }

  summaryDeliveryMode.textContent = "Not configured";
}

function renderPendingImages() {
  if (!state.pendingImages.length) {
    attachmentList.innerHTML = "";
    attachmentList.classList.add("hidden");
    return;
  }

  attachmentList.classList.remove("hidden");
  attachmentList.innerHTML = state.pendingImages
    .map((image) => `
      <article class="attachment-card" data-image-id="${escapeAttr(image.id)}">
        <img class="attachment-thumb" src="${escapeAttr(image.dataUrl)}" alt="${escapeAttr(image.name)}">
        <div class="attachment-meta">
          <strong class="attachment-name">${escapeHtml(image.name)}</strong>
          <span class="attachment-size">${escapeHtml(formatBytes(image.size))}</span>
        </div>
        <button class="ghost attachment-remove" type="button" data-remove-image="${escapeAttr(image.id)}">Remove</button>
      </article>
    `)
    .join("");
}

function clearPendingImages() {
  state.pendingImages = [];
  imageInput.value = "";
  renderPendingImages();
}

async function addPendingImages(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }

  const remainingSlots = MAX_PENDING_IMAGES - state.pendingImages.length;
  if (remainingSlots <= 0) {
    composerHint.textContent = `You can attach up to ${MAX_PENDING_IMAGES} images at once.`;
    imageInput.value = "";
    return;
  }

  const nextFiles = files.filter((file) => String(file.type || "").startsWith("image/")).slice(0, remainingSlots);
  const loaded = [];

  for (const file of nextFiles) {
    if (file.size > MAX_PENDING_IMAGE_BYTES) {
      composerHint.textContent = `Each image must be ${(MAX_PENDING_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB or smaller.`;
      continue;
    }

    loaded.push({
      id: createClientId(),
      name: file.name || "image",
      type: file.type || "image/png",
      size: file.size || 0,
      dataUrl: await fileToDataUrl(file)
    });
  }

  state.pendingImages.push(...loaded);
  renderPendingImages();
  imageInput.value = "";

  if (files.length > remainingSlots) {
    composerHint.textContent = `Only the first ${remainingSlots} image${remainingSlots === 1 ? "" : "s"} were added.`;
    return;
  }

  if (loaded.length) {
    composerHint.textContent = `${state.pendingImages.length} image${state.pendingImages.length === 1 ? "" : "s"} attached.`;
  }
}

function renderPairingLinks() {
  if (!state.pairing) {
    pairLinksInline.innerHTML = `
      <div class="empty-state">
        <p>Loading QR access links...</p>
      </div>
    `;
    return;
  }

  if (!state.pairing?.links?.length) {
    pairLinksInline.innerHTML = `
      <div class="empty-state">
        <p>No usable access URL is configured yet. Set a public URL or use the local network address.</p>
      </div>
    `;
    return;
  }

  pairLinksInline.innerHTML = state.pairing.links
    .map((link) => `
      <article class="pair-link-card">
        <div>
          <p class="eyebrow">${escapeHtml(link.label)}</p>
          <h2>${escapeHtml(link.label)}</h2>
          <p class="hint">${escapeHtml(link.description || "")}</p>
        </div>
        <div class="qr-frame">
          <img src="${escapeAttr(link.qrDataUrl)}" alt="${escapeAttr(`QR code for ${link.label}`)}">
        </div>
        <div class="pair-link-row">
          <input type="text" readonly value="${escapeAttr(link.url)}">
          <button class="ghost" type="button" data-copy-link="${escapeAttr(link.url)}">Copy Link</button>
          <a class="ghost" href="${escapeAttr(link.url)}" target="_blank" rel="noreferrer">Open</a>
        </div>
      </article>
    `)
    .join("");
}

function renderPairingPanel() {
  const local = isLocalBrowser();
  pairingRemoteNote.classList.toggle("hidden", local);
  pairingLocalPanel.classList.toggle("hidden", !local);

  if (!local) {
    pairStatusInline.textContent = "";
    return;
  }

  pairTokenInline.value = state.pairing?.token || "";
  renderPairingLinks();
}

async function ensurePairingLoaded({ force = false } = {}) {
  renderPairingPanel();
  if (!isLocalBrowser()) {
    return;
  }

  if (state.pairing && !force) {
    return;
  }

  pairStatusInline.textContent = force ? "Refreshing QR access..." : "Loading QR access...";

  try {
    const payload = await plainFetch("/api/pairing");
    state.pairing = payload.pairing;
    renderPairingPanel();
    pairStatusInline.textContent = "";
  } catch (error) {
    pairStatusInline.textContent = error.message;
  }
}

function getDefaultWorkspace() {
  return state.settings?.defaultWorkspaceRoot || "";
}

function openSettingsDialog() {
  applySettingsToDialog();
  settingsDialog.showModal();
}

function renderComposerState() {
  const defaultWorkspace = getDefaultWorkspace();
  if (state.selectedThread) {
    composerTarget.textContent = `Replying in the selected thread. Workspace: ${state.selectedThread.cwd || defaultWorkspace}`;
    promptInput.placeholder = "Reply to the selected thread.";
    return;
  }
  composerTarget.textContent = `Starting a new thread in the default workspace: ${defaultWorkspace || "not set"}`;
  promptInput.placeholder = "Type a message to start a new thread.";
}

function threadHasUserMessage(thread, text) {
  const expected = String(text || "").trim();
  if (!expected || !thread?.messages?.length) {
    return false;
  }
  return thread.messages.some((message) => message.role === "user" && String(message.text || "").trim() === expected);
}

function syncOptimisticMessages() {
  state.optimisticMessages = state.optimisticMessages.filter((entry) => {
    const job = state.jobs.find((item) => item.id === entry.jobId);
    if (!job) {
      return false;
    }

    entry.status = job.status || entry.status;
    if (job.threadId) {
      entry.threadId = job.threadId;
    }

    if (job.status === "failed") {
      return false;
    }

    if (state.selectedThread && entry.threadId === state.selectedThread.id && threadHasUserMessage(state.selectedThread, entry.text)) {
      return false;
    }

    if (
      state.selectedThread &&
      entry.threadId === null &&
      entry.targetThreadId === state.selectedThread.id &&
      threadHasUserMessage(state.selectedThread, entry.text)
    ) {
      return false;
    }

    return true;
  });
}

function getVisibleOptimisticMessages() {
  if (state.selectedThreadId) {
    return state.optimisticMessages.filter((entry) =>
      entry.targetThreadId === state.selectedThreadId || entry.threadId === state.selectedThreadId
    );
  }
  return state.optimisticMessages.filter((entry) => !entry.targetThreadId);
}

function renderMessageCard(message, { optimistic = false } = {}) {
  const roleClass = message.role === "assistant" ? "message assistant" : "message user";
  const optimisticClass = optimistic ? ` optimistic ${message.status || "queued"}` : "";
  return `
    <article class="${roleClass}${optimisticClass}">
      <div class="message-head">
        <span class="role">${escapeHtml(message.role)}</span>
        <span class="phase">${escapeHtml(message.phase)}</span>
        <span class="stamp">${escapeHtml(relativeTime(message.timestamp || message.createdAt || new Date().toISOString()))}</span>
      </div>
      <pre>${escapeHtml(message.text)}</pre>
    </article>
  `;
}

function clearSelectedThread() {
  state.selectedThreadId = null;
  state.selectedThread = null;
  state.requestedThreadId = "";
  renderThreads();
  renderThreadDetail();
  setLayoutTab("conversation");
  updateUrl("");
}

function renderThreads() {
  const filtered = state.threads
    .filter((thread) => {
      const haystack = `${thread.title} ${thread.firstUserMessage} ${thread.lastAssistantMessage}`.toLowerCase();
      return haystack.includes(state.searchText.toLowerCase());
    })
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime() || 0;
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime() || 0;
      return rightTime - leftTime;
    });

  if (!filtered.length) {
    threadList.innerHTML = `<div class="empty-state"><p>No matching threads.</p></div>`;
    return;
  }

  threadList.innerHTML = filtered
    .map((thread) => {
      const activeClass = thread.id === state.selectedThreadId ? "thread-card active" : "thread-card";
      return `
        <button class="${activeClass}" data-thread-id="${escapeAttr(thread.id)}" type="button">
          <div class="thread-card-top">
            <strong class="thread-title">${escapeHtml(thread.title || "Untitled thread")}</strong>
            <span class="thread-time">${escapeHtml(relativeTime(thread.updatedAt))}</span>
          </div>
          <p class="thread-preview">${escapeHtml(thread.firstUserMessage || "No prompt yet")}</p>
          <div class="thread-card-bottom">
            <span class="thread-workspace">${escapeHtml(thread.cwd || "workspace unknown")}</span>
            <span class="thread-count">${thread.messageCount || 0} msgs</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderThreadDetail() {
  const thread = state.selectedThread;
  const optimisticMessages = getVisibleOptimisticMessages();
  if (!thread) {
    threadTitle.textContent = "New Chat";
    threadMeta.innerHTML = `<span>${escapeHtml(getDefaultWorkspace() || "Default workspace not set")}</span>`;
    if (!optimisticMessages.length) {
      messageList.innerHTML = `<div class="empty-state"><p>Your next message will start a new thread in the default workspace.</p></div>`;
    } else {
      messageList.innerHTML = optimisticMessages
        .map((message) =>
          renderMessageCard(
            {
              role: "user",
              phase: message.status === "running" ? "running" : "queued",
              timestamp: message.createdAt,
              text: message.text,
              status: message.status
            },
            { optimistic: true }
          )
        )
        .join("");
    }
    renderComposerState();
    return;
  }

  threadTitle.textContent = thread.title || "Untitled thread";
  threadMeta.innerHTML = `
    <span>${escapeHtml(thread.cwd || "")}</span>
    <span>${escapeHtml(relativeTime(thread.updatedAt))}</span>
  `;

  const messages = thread.messages || [];
  if (!messages.length && !optimisticMessages.length) {
    messageList.innerHTML = `<div class="empty-state"><p>No visible user or assistant messages yet.</p></div>`;
    renderComposerState();
    return;
  }

  messageList.innerHTML = messages
    .map((message) => renderMessageCard(message))
    .concat(
      optimisticMessages.map((message) =>
        renderMessageCard(
          {
            role: "user",
            phase: message.status === "running" ? "running" : "queued",
            timestamp: message.createdAt,
            text: message.text,
            status: message.status
          },
          { optimistic: true }
        )
      )
    )
    .join("");
  renderComposerState();
}

function renderJobs() {
  if (!state.jobs.length) {
    statusStrip.innerHTML = `<div class="status-card idle"><strong>Idle</strong><p>No jobs are queued right now.</p></div>`;
    return;
  }

  statusStrip.innerHTML = state.jobs
    .slice(0, 3)
    .map((job) => {
      const statusClass = `status-card ${job.status}`;
      const promptPreview = job.imageCount
        ? `${job.promptPreview || ""} (+${job.imageCount} image${job.imageCount === 1 ? "" : "s"})`
        : job.promptPreview || "";
      return `
        <div class="${statusClass}">
          <strong>${escapeHtml(job.status.toUpperCase())}</strong>
          <p>${escapeHtml(promptPreview)}</p>
          <span>${escapeHtml(job.workspaceRoot || "")}</span>
        </div>
      `;
    })
    .join("");
}

function renderWorkspaceOptions() {
  const options = (state.settings?.workspaceRoots || [])
    .map((root) => `<option value="${escapeAttr(root)}">${escapeHtml(root)}</option>`)
    .join("");

  settingsWorkspace.innerHTML = options;
  settingsWorkspace.value = state.settings?.defaultWorkspaceRoot || "";
}

function upsertThreadSummary(thread) {
  if (!thread?.id) {
    return;
  }

  const summary = {
    id: thread.id,
    title: thread.title || thread.firstUserMessage || "Untitled thread",
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    cwd: thread.cwd,
    source: thread.source,
    cliVersion: thread.cliVersion,
    firstUserMessage: thread.firstUserMessage || "",
    lastAssistantMessage: thread.lastAssistantMessage || "",
    messageCount: (thread.messages || []).length
  };

  const existingIndex = state.threads.findIndex((item) => item.id === thread.id);
  if (existingIndex >= 0) {
    state.threads.splice(existingIndex, 1, {
      ...state.threads[existingIndex],
      ...summary
    });
    return;
  }

  state.threads.unshift(summary);
}

async function loadThread(threadId, { updateAddressBar = true } = {}) {
  const payload = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`);
  state.selectedThreadId = threadId;
  state.selectedThread = payload.thread;
  state.requestedThreadId = threadId;
  state.pendingNewJobId = "";
  upsertThreadSummary(payload.thread);
  syncOptimisticMessages();
  renderThreads();
  renderThreadDetail();
  setLayoutTab("conversation");
  if (updateAddressBar) {
    updateUrl(threadId);
  }
}

async function bootstrap() {
  const payload = await apiFetch("/api/bootstrap");
  state.settings = payload.settings;
  state.threads = payload.threads;
  state.jobs = payload.jobs;
  syncOptimisticMessages();

  setLoggedIn(true);
  renderWorkspaceOptions();
  applySettingsToDialog();
  renderSettingsSummary();
  renderThreads();
  renderJobs();
  renderPairingPanel();
  setLayoutTab(state.activeLayoutTab);
  setUtilityTab(state.activeUtilityTab);

  const preferredThreadId = state.requestedThreadId || state.selectedThreadId;

  if (preferredThreadId) {
    await loadThread(preferredThreadId).catch(() => {
      clearSelectedThread();
    });
  } else {
    renderThreadDetail();
  }

  connectEvents();
}

function connectEvents() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);

  state.eventSource.addEventListener("jobs", (event) => {
    state.jobs = JSON.parse(event.data);
    syncOptimisticMessages();
    renderJobs();

    if (!state.pendingNewJobId) {
      return;
    }

    const pendingJob = state.jobs.find((job) => job.id === state.pendingNewJobId);
    if (!pendingJob?.threadId) {
      return;
    }

    void apiFetch("/api/threads").then((payload) => {
      state.threads = payload.threads;
      renderThreads();
      return loadThread(pendingJob.threadId);
    }).then(() => {
      composerHint.textContent = "New thread started.";
    }).catch(() => {});
  });

  state.eventSource.addEventListener("threads", async (event) => {
    state.threads = JSON.parse(event.data);
    renderThreads();
    if (state.selectedThreadId) {
      await loadThread(state.selectedThreadId, { updateAddressBar: false }).catch(() => {});
    }
  });

  state.eventSource.addEventListener("thread", (event) => {
    const payload = JSON.parse(event.data);
    upsertThreadSummary(payload);
    if (payload.id === state.selectedThreadId) {
      state.selectedThread = payload;
    }
    syncOptimisticMessages();
    renderThreads();
    if (payload.id === state.selectedThreadId) {
      renderThreadDetail();
    }
  });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  state.token = tokenInput.value.trim();
  try {
    await bootstrap();
    localStorage.setItem("codexRelayToken", state.token);
    clearTokenFromUrl();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

layoutTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-layout-tab]");
  if (!button) {
    return;
  }
  setLayoutTab(button.dataset.layoutTab);
});

utilityTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-utility-tab]");
  if (!button) {
    return;
  }
  setUtilityTab(button.dataset.utilityTab);
});

threadList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-thread-id]");
  if (!button) {
    return;
  }
  await loadThread(button.dataset.threadId);
});

newThreadButton.addEventListener("click", () => {
  clearSelectedThread();
  promptInput.focus();
});

threadSearch.addEventListener("input", (event) => {
  state.searchText = event.target.value;
  renderThreads();
});

imageInput.addEventListener("change", async (event) => {
  await addPendingImages(event.target.files).catch((error) => {
    composerHint.textContent = error.message;
  });
});

attachmentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-image]");
  if (!button) {
    return;
  }
  state.pendingImages = state.pendingImages.filter((image) => image.id !== button.dataset.removeImage);
  renderPendingImages();
});

refreshButton.addEventListener("click", async () => {
  const threadsPayload = await apiFetch("/api/threads");
  const jobsPayload = await apiFetch("/api/jobs");
  state.threads = threadsPayload.threads;
  state.jobs = jobsPayload.jobs;
  renderThreads();
  renderJobs();
  renderSettingsSummary();
  if (state.selectedThreadId) {
    await loadThread(state.selectedThreadId, { updateAddressBar: false }).catch(() => {});
  }
});

composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  composerHint.textContent = "";

  const prompt = promptInput.value.trim();
  if (!prompt) {
    composerHint.textContent = "Enter a message first.";
    return;
  }

  const payload = {
    prompt,
    images: state.pendingImages.map((image) => ({
      name: image.name,
      type: image.type,
      dataUrl: image.dataUrl
    }))
  };
  const isNewThread = !state.selectedThreadId;

  if (!isNewThread) {
    payload.resumeThreadId = state.selectedThreadId;
    payload.workspaceRoot = state.selectedThread?.cwd || getDefaultWorkspace();
  } else {
    payload.workspaceRoot = getDefaultWorkspace();
  }

  try {
    const response = await apiFetch("/api/threads", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const continuationMode = response.job?.continuationMode || (isNewThread ? "new" : "resume");
    const followNewThread = isNewThread || continuationMode === "fork";

    promptInput.value = "";
    clearPendingImages();

    if (isNewThread) {
      state.requestedThreadId = "";
      state.selectedThread = null;
      state.selectedThreadId = null;
    }
    if (followNewThread) {
      state.pendingNewJobId = response.job?.id || "";
    }
    if (continuationMode === "fork") {
      composerHint.textContent = "Queued as a linked new thread.";
    } else {
      composerHint.textContent = isNewThread ? "Queued as a new thread." : "Queued for the current thread.";
    }

    state.optimisticMessages.push({
      jobId: response.job?.id || createClientId(),
      text: prompt,
      createdAt: new Date().toISOString(),
      status: "queued",
      targetThreadId: isNewThread ? null : state.selectedThreadId,
      threadId: null,
      continuationMode
    });
    renderThreadDetail();

    if (followNewThread && response.job?.id) {
      const syncNewThread = async () => {
        for (let attempt = 0; attempt < 18; attempt += 1) {
          const jobsPayload = await apiFetch("/api/jobs");
          state.jobs = jobsPayload.jobs;
          renderJobs();
          const queuedJob = state.jobs.find((job) => job.id === response.job.id);
          if (queuedJob?.threadId) {
            const threadsPayload = await apiFetch("/api/threads");
            state.threads = threadsPayload.threads;
            renderThreads();
            await loadThread(queuedJob.threadId);
            composerHint.textContent = continuationMode === "fork" ? "Linked thread started." : "New thread started.";
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      };
      void syncNewThread().catch(() => {});
    }
  } catch (error) {
    composerHint.textContent = error.message;
  }
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composerForm.requestSubmit();
  }
});

settingsButton.addEventListener("click", () => {
  openSettingsDialog();
});

accessSettingsButton.addEventListener("click", () => {
  openSettingsDialog();
});

closeSettingsButton.addEventListener("click", () => settingsDialog.close());

copyTokenInlineButton.addEventListener("click", async () => {
  try {
    await copyText(pairTokenInline.value);
    pairStatusInline.textContent = "Token copied.";
  } catch (error) {
    pairStatusInline.textContent = error.message;
  }
});

pairLinksInline.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-link]");
  if (!button) {
    return;
  }
  try {
    await copyText(button.dataset.copyLink);
    pairStatusInline.textContent = "Link copied.";
  } catch (error) {
    pairStatusInline.textContent = error.message;
  }
});

regenerateTokenInlineButton.addEventListener("click", async () => {
  if (!window.confirm("Regenerate the dashboard token? Existing shared links will stop working.")) {
    return;
  }

  pairStatusInline.textContent = "Regenerating token...";
  try {
    const payload = await plainFetch("/api/pairing/regenerate", {
      method: "POST"
    });
    state.pairing = payload.pairing;
    renderPairingPanel();
    pairStatusInline.textContent = "Token regenerated.";
  } catch (error) {
    pairStatusInline.textContent = error.message;
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsHint.textContent = "";

  const payload = await apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      defaultWorkspaceRoot: settingsWorkspace.value,
      publicBaseUrl: publicBaseUrlInput.value.trim(),
      discordWebhookUrl: webhookInput.value.trim(),
      discordBotToken: botTokenInput.value.trim(),
      discordChannelId: channelIdInput.value.trim(),
      notificationEnabled: notifyToggle.checked
    })
  });

  state.settings = {
    ...state.settings,
    ...payload.settings
  };

  renderWorkspaceOptions();
  applySettingsToDialog();
  renderSettingsSummary();
  renderThreadDetail();
  settingsHint.textContent = "Saved.";
  settingsDialog.close();
  void ensurePairingLoaded({ force: true });
});

window.addEventListener("resize", () => {
  setLayoutTab(state.activeLayoutTab);
});

if (state.token) {
  tokenInput.value = state.token;
  bootstrap()
    .then(() => {
      localStorage.setItem("codexRelayToken", state.token);
      clearTokenFromUrl();
    })
    .catch(() => {
      setLoggedIn(false);
      localStorage.removeItem("codexRelayToken");
    });
}

if (pairingEntry && isLocalBrowser()) {
  pairingEntry.classList.remove("hidden");
}
