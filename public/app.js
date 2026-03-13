const urlState = new URL(window.location.href);

const state = {
  token: urlState.searchParams.get("token") || localStorage.getItem("codexRelayToken") || "",
  threads: [],
  jobs: [],
  settings: null,
  selectedThreadId: null,
  selectedThread: null,
  requestedThreadId: urlState.searchParams.get("thread") || "",
  searchText: "",
  eventSource: null
};

const loginCard = document.querySelector("#login-card");
const appShell = document.querySelector("#app");
const loginForm = document.querySelector("#login-form");
const tokenInput = document.querySelector("#token-input");
const loginError = document.querySelector("#login-error");
const threadList = document.querySelector("#thread-list");
const threadTitle = document.querySelector("#thread-title");
const threadMeta = document.querySelector("#thread-meta");
const messageList = document.querySelector("#message-list");
const newThreadButton = document.querySelector("#new-thread-button");
const settingsWorkspace = document.querySelector("#settings-workspace");
const promptInput = document.querySelector("#prompt-input");
const composerForm = document.querySelector("#composer-form");
const composerTarget = document.querySelector("#composer-target");
const composerHint = document.querySelector("#composer-hint");
const statusStrip = document.querySelector("#status-strip");
const threadSearch = document.querySelector("#thread-search");
const refreshButton = document.querySelector("#refresh-button");
const settingsButton = document.querySelector("#settings-button");
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

function updateUrl(threadId) {
  const nextUrl = new URL(window.location.href);
  if (threadId) {
    nextUrl.searchParams.set("thread", threadId);
  } else {
    nextUrl.searchParams.delete("thread");
  }
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

function getDefaultWorkspace() {
  return state.settings?.defaultWorkspaceRoot || "";
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

function clearSelectedThread() {
  state.selectedThreadId = null;
  state.selectedThread = null;
  state.requestedThreadId = "";
  renderThreads();
  renderThreadDetail();
  updateUrl("");
}

function renderThreads() {
  const filtered = state.threads.filter((thread) => {
    const haystack = `${thread.title} ${thread.firstUserMessage} ${thread.lastAssistantMessage}`.toLowerCase();
    return haystack.includes(state.searchText.toLowerCase());
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
            <strong>${escapeHtml(thread.title || "Untitled thread")}</strong>
            <span>${escapeHtml(relativeTime(thread.updatedAt))}</span>
          </div>
          <p>${escapeHtml(thread.firstUserMessage || "No prompt yet")}</p>
          <div class="thread-card-bottom">
            <span>${escapeHtml(thread.cwd || "workspace unknown")}</span>
            <span>${thread.messageCount || 0} msgs</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderThreadDetail() {
  const thread = state.selectedThread;
  if (!thread) {
    threadTitle.textContent = "New Chat";
    threadMeta.innerHTML = `<span>${escapeHtml(getDefaultWorkspace() || "Default workspace not set")}</span>`;
    messageList.innerHTML = `<div class="empty-state"><p>Your next message will start a new thread in the default workspace.</p></div>`;
    renderComposerState();
    return;
  }

  threadTitle.textContent = thread.title || "Untitled thread";
  threadMeta.innerHTML = `
    <span>${escapeHtml(thread.cwd || "")}</span>
    <span>${escapeHtml(relativeTime(thread.updatedAt))}</span>
  `;

  const messages = thread.messages || [];
  if (!messages.length) {
    messageList.innerHTML = `<div class="empty-state"><p>No visible user or assistant messages yet.</p></div>`;
    renderComposerState();
    return;
  }

  messageList.innerHTML = messages
    .map((message) => {
      const roleClass = message.role === "assistant" ? "message assistant" : "message user";
      return `
        <article class="${roleClass}">
          <div class="message-head">
            <span class="role">${escapeHtml(message.role)}</span>
            <span class="phase">${escapeHtml(message.phase)}</span>
            <span class="stamp">${escapeHtml(relativeTime(message.timestamp))}</span>
          </div>
          <pre>${escapeHtml(message.text)}</pre>
        </article>
      `;
    })
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
      return `
        <div class="${statusClass}">
          <strong>${escapeHtml(job.status.toUpperCase())}</strong>
          <p>${escapeHtml(job.promptPreview || "")}</p>
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

async function loadThread(threadId, { updateAddressBar = true } = {}) {
  const payload = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`);
  state.selectedThreadId = threadId;
  state.selectedThread = payload.thread;
  state.requestedThreadId = threadId;
  renderThreads();
  renderThreadDetail();
  if (updateAddressBar) {
    updateUrl(threadId);
  }
}

async function bootstrap() {
  const payload = await apiFetch("/api/bootstrap");
  state.settings = payload.settings;
  state.threads = payload.threads;
  state.jobs = payload.jobs;

  setLoggedIn(true);
  renderWorkspaceOptions();
  applySettingsToDialog();
  renderThreads();
  renderJobs();

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
    renderJobs();
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
    if (payload.id === state.selectedThreadId) {
      state.selectedThread = payload;
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
  } catch (error) {
    loginError.textContent = error.message;
  }
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

refreshButton.addEventListener("click", async () => {
  const threadsPayload = await apiFetch("/api/threads");
  const jobsPayload = await apiFetch("/api/jobs");
  state.threads = threadsPayload.threads;
  state.jobs = jobsPayload.jobs;
  renderThreads();
  renderJobs();
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
    workspaceRoot: getDefaultWorkspace()
  };

  if (state.selectedThreadId) {
    payload.resumeThreadId = state.selectedThreadId;
  }

  const response = await apiFetch("/api/threads", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  promptInput.value = "";
  if (!state.selectedThreadId) {
    state.requestedThreadId = "";
    state.selectedThread = null;
    state.selectedThreadId = null;
  }
  composerHint.textContent = state.selectedThreadId ? "Queued for the current thread." : "Queued as a new thread.";
  if (!state.selectedThreadId && response.job?.id) {
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
          composerHint.textContent = "New thread started.";
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    };
    void syncNewThread().catch(() => {});
  }
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composerForm.requestSubmit();
  }
});

settingsButton.addEventListener("click", () => {
  applySettingsToDialog();
  settingsDialog.showModal();
});

closeSettingsButton.addEventListener("click", () => settingsDialog.close());

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
  renderThreadDetail();
  settingsHint.textContent = "Saved.";
  settingsDialog.close();
});

if (state.token) {
  tokenInput.value = state.token;
  bootstrap().catch(() => {
    setLoggedIn(false);
    localStorage.removeItem("codexRelayToken");
  });
}
