const tokenInput = document.querySelector("#pair-token");
const copyTokenButton = document.querySelector("#copy-token-button");
const regenerateTokenButton = document.querySelector("#regenerate-token-button");
const pairLinks = document.querySelector("#pair-links");
const pairStatus = document.querySelector("#pair-status");

let pairingState = null;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll('"', "&quot;");
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

async function apiFetch(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function renderLinks() {
  if (!pairingState?.links?.length) {
    pairLinks.innerHTML = `
      <div class="empty-state">
        <p>No usable access URL is configured yet. Set a public URL or use the local network address.</p>
      </div>
    `;
    return;
  }

  pairLinks.innerHTML = pairingState.links
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

function renderPairing() {
  tokenInput.value = pairingState?.token || "";
  renderLinks();
}

async function loadPairing() {
  pairStatus.textContent = "";
  const payload = await apiFetch("/api/pairing");
  pairingState = payload.pairing;
  renderPairing();
}

copyTokenButton.addEventListener("click", async () => {
  try {
    await copyText(tokenInput.value);
    pairStatus.textContent = "Token copied.";
  } catch (error) {
    pairStatus.textContent = error.message;
  }
});

pairLinks.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-link]");
  if (!button) {
    return;
  }
  try {
    await copyText(button.dataset.copyLink);
    pairStatus.textContent = "Link copied.";
  } catch (error) {
    pairStatus.textContent = error.message;
  }
});

regenerateTokenButton.addEventListener("click", async () => {
  if (!window.confirm("Regenerate the dashboard token? Existing shared links will stop working.")) {
    return;
  }

  pairStatus.textContent = "Regenerating token...";
  try {
    const payload = await apiFetch("/api/pairing/regenerate", {
      method: "POST"
    });
    pairingState = payload.pairing;
    renderPairing();
    pairStatus.textContent = "Token regenerated.";
  } catch (error) {
    pairStatus.textContent = error.message;
  }
});

loadPairing().catch((error) => {
  pairStatus.textContent = error.message;
});
