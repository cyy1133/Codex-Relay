import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS_HOST = process.platform === "win32";
const LOCAL_HOME = os.homedir();
const LOCAL_USERNAME = path.basename(LOCAL_HOME);
const WINDOWS_HOME = IS_WINDOWS_HOST ? LOCAL_HOME : path.join("/mnt/c/Users", LOCAL_USERNAME);
const DEFAULT_WSL_DISTRO_NAME = process.env.CODEX_RELAY_WSL_DISTRO || "Ubuntu";
const DEFAULT_WSL_HOME_PATH = process.env.CODEX_RELAY_WSL_HOME || `/home/${LOCAL_USERNAME}`;
const STATIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_THREADS = 50;
const DEFAULT_WORKSPACE = __dirname;
const CMD_EXE = process.env.ComSpec || "cmd.exe";
const EXECUTION_MODE = process.env.CODEX_RELAY_EXECUTION_MODE || "bypass";
const EXEC_SANDBOX = process.env.CODEX_RELAY_SANDBOX || "workspace-write";
const EXEC_APPROVAL = process.env.CODEX_RELAY_APPROVAL || "never";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

let settings = null;
let sessionFileMap = new Map();
const threadCache = new Map();
const sseClients = new Set();
const jobs = [];
const jobQueue = [];
let activeJobId = null;
let isProcessingQueue = false;

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function trimText(text, limit = 280) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}...`;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeExecutionBackend(value) {
  return String(value || "").trim().toLowerCase() === "wsl" ? "wsl" : "windows";
}

function normalizeWslHomePath(value) {
  const trimmed = String(value || "").trim().replace(/\\/g, "/");
  if (!trimmed) {
    return DEFAULT_WSL_HOME_PATH;
  }
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed.replace(/^\/+/, "")}`;
  return normalized.replace(/\/+$/, "");
}

function getWslConfig() {
  return {
    distroName: String(settings?.wslDistroName || DEFAULT_WSL_DISTRO_NAME).trim() || DEFAULT_WSL_DISTRO_NAME,
    homePath: normalizeWslHomePath(settings?.wslHomePath || DEFAULT_WSL_HOME_PATH)
  };
}

function toWslUncPath(distroName, linuxPath) {
  const normalized = normalizeWslHomePath(linuxPath).replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distroName}${normalized}`;
}

function getCodexHomes() {
  const homes = new Set();

  if (IS_WINDOWS_HOST) {
    homes.add(path.join(LOCAL_HOME, ".codex"));
    const wslConfig = getWslConfig();
    homes.add(path.join(toWslUncPath(wslConfig.distroName, wslConfig.homePath), ".codex"));
  } else {
    homes.add(process.env.CODEX_HOME || path.join(LOCAL_HOME, ".codex"));
    homes.add(path.join(WINDOWS_HOME, ".codex"));
  }

  return Array.from(homes);
}

function getSessionDirs() {
  return getCodexHomes().map((home) => path.join(home, "sessions"));
}

function getSessionIndexPaths() {
  return getCodexHomes().map((home) => path.join(home, "session_index.jsonl"));
}

function getGlobalStatePaths() {
  return getCodexHomes().map((home) => path.join(home, ".codex-global-state.json"));
}

function buildUrl(baseUrl, params = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return "";
  }
  try {
    const url = new URL(normalized);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return normalized;
  }
}

function buildDashboardUrl(threadId = "") {
  const baseUrl = normalizeBaseUrl(settings.publicBaseUrl) || `http://localhost:${PORT}`;
  return buildUrl(baseUrl, { thread: threadId });
}

function formatTimestamp(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".png") {
    return "image/png";
  }
  return "application/octet-stream";
}

function isLoopbackAddress(value) {
  return LOOPBACK_ADDRESSES.has(String(value || "").toLowerCase());
}

function isLocalRequest(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

function isPrivateIpv4(value) {
  if (!value || typeof value !== "string") {
    return false;
  }
  if (value.startsWith("10.") || value.startsWith("192.168.")) {
    return true;
  }
  const match = value.match(/^172\.(\d+)\./);
  if (!match) {
    return false;
  }
  const octet = Number(match[1]);
  return octet >= 16 && octet <= 31;
}

function isTailscaleIpv4(value) {
  if (!value || typeof value !== "string") {
    return false;
  }
  const match = value.match(/^100\.(\d+)\./);
  if (!match) {
    return false;
  }
  const octet = Number(match[1]);
  return octet >= 64 && octet <= 127;
}

function getLanBaseUrls() {
  const interfaces = os.networkInterfaces();
  const privateUrls = [];
  const otherUrls = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal || !entry.address) {
        continue;
      }
      const url = `http://${entry.address}:${PORT}`;
      if (isPrivateIpv4(entry.address)) {
        privateUrls.push(url);
      } else {
        otherUrls.push(url);
      }
    }
  }

  return Array.from(new Set([...privateUrls, ...otherUrls]));
}

function getTailscaleBaseUrls() {
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal || !entry.address) {
        continue;
      }
      if (!isTailscaleIpv4(entry.address)) {
        continue;
      }
      urls.push(`http://${entry.address}:${PORT}`);
    }
  }

  return Array.from(new Set(urls));
}

function disconnectEventClients() {
  for (const client of sseClients) {
    client.end();
  }
  sseClients.clear();
}

function extractToken(req, url) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const headerToken = req.headers["x-codex-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }
  return url.searchParams.get("token") || "";
}

function sanitizeWorkspaceRoots(rawRoots) {
  const unique = new Set();
  for (const root of rawRoots || []) {
    if (typeof root !== "string") {
      continue;
    }
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    unique.add(trimmed);
  }
  if (!unique.size) {
    unique.add(DEFAULT_WORKSPACE);
  }
  return Array.from(unique);
}

async function loadWorkspaceRoots() {
  const roots = [];
  for (const globalStatePath of getGlobalStatePaths()) {
    const raw = await readTextFile(globalStatePath);
    const parsed = safeJsonParse(raw, {});
    roots.push(
      ...(parsed["active-workspace-roots"] || []),
      ...(parsed["electron-saved-workspace-roots"] || [])
    );
  }
  roots.push(DEFAULT_WORKSPACE);
  return sanitizeWorkspaceRoots(roots);
}

async function loadSettings() {
  await ensureDir(DATA_DIR);
  const workspaceRoots = await loadWorkspaceRoots();
  const existing = safeJsonParse(await readTextFile(SETTINGS_PATH), {});
  settings = {
    authToken: firstDefined(existing.authToken, crypto.randomBytes(24).toString("hex")),
    workspaceRoots: sanitizeWorkspaceRoots([
      ...(existing.workspaceRoots || []),
      ...workspaceRoots
    ]),
    defaultWorkspaceRoot: null,
    discordWebhookUrl: typeof existing.discordWebhookUrl === "string" ? existing.discordWebhookUrl : "",
    discordBotToken: typeof existing.discordBotToken === "string" ? existing.discordBotToken : "",
    discordChannelId: typeof existing.discordChannelId === "string" ? existing.discordChannelId : "",
    publicBaseUrl: normalizeBaseUrl(existing.publicBaseUrl || ""),
    tailscaleBaseUrl: normalizeBaseUrl(existing.tailscaleBaseUrl || ""),
    executionBackend: normalizeExecutionBackend(existing.executionBackend || "windows"),
    wslDistroName: typeof existing.wslDistroName === "string" ? existing.wslDistroName.trim() : DEFAULT_WSL_DISTRO_NAME,
    wslHomePath: normalizeWslHomePath(existing.wslHomePath || DEFAULT_WSL_HOME_PATH),
    notificationEnabled: Boolean(existing.notificationEnabled)
  };
  settings.defaultWorkspaceRoot =
    settings.workspaceRoots.find((root) => root === existing.defaultWorkspaceRoot) ||
    settings.workspaceRoots[0];
  await saveSettings();
}

async function saveSettings() {
  if (!settings) {
    return;
  }
  await ensureDir(DATA_DIR);
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

async function walkDir(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function refreshSessionFileMap() {
  const files = [];
  for (const sessionsDir of getSessionDirs()) {
    if (await fileExists(sessionsDir)) {
      files.push(...await walkDir(sessionsDir));
    }
  }
  const nextMap = new Map();
  for (const filePath of files) {
    const match = filePath.match(/([0-9a-f-]{36})\.jsonl$/i);
    if (match) {
      nextMap.set(match[1], filePath);
    }
  }
  sessionFileMap = nextMap;
}

async function ensureThreadFile(threadId) {
  if (!sessionFileMap.has(threadId)) {
    await refreshSessionFileMap();
  }
  return sessionFileMap.get(threadId) || null;
}

function messageTextFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => firstDefined(part?.text, part?.output_text, part?.input_text, ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isInjectedUserContext(text) {
  return text.includes("# AGENTS.md instructions") || text.includes("<environment_context>");
}

function isInternalAutomationPrompt(text) {
  return text.startsWith("You are running inside Codex CLI in non-interactive mode.");
}

function buildThreadSummary(thread, messageCount) {
  return {
    id: thread.id,
    title: thread.title || thread.firstUserMessage || "Untitled thread",
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    cwd: thread.cwd,
    backend: thread.backend || "windows",
    source: thread.source,
    cliVersion: thread.cliVersion,
    firstUserMessage: trimText(thread.firstUserMessage, 200),
    lastAssistantMessage: trimText(thread.lastAssistantMessage, 240),
    messageCount
  };
}

function detectThreadBackend(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (IS_WINDOWS_HOST) {
    return normalized.startsWith("\\\\wsl.localhost\\") ? "wsl" : "windows";
  }
  return normalized.startsWith("/mnt/c/users/") ? "windows" : "wsl";
}

async function parseThreadFile(filePath) {
  const stats = await fs.stat(filePath);
  const cached = threadCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return cached.parsed;
  }

  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages = [];
  let meta = null;
  let title = "";
  let firstUserMessage = "";
  let lastAssistantMessage = "";

  for (const line of lines) {
    const record = safeJsonParse(line, null);
    if (!record || typeof record !== "object") {
      continue;
    }
    if (record.type === "session_meta") {
      const payload = record.payload || {};
      meta = {
        id: payload.id,
        createdAt: payload.timestamp || record.timestamp,
        cwd: payload.cwd,
        source: payload.source,
        cliVersion: payload.cli_version
      };
      continue;
    }
    if (record.type !== "response_item") {
      continue;
    }
    const payload = record.payload || {};
    if (payload.type !== "message") {
      continue;
    }
    if (!["user", "assistant"].includes(payload.role)) {
      continue;
    }
    const text = messageTextFromContent(payload.content);
    if (!text) {
      continue;
    }
    const phase = payload.phase || (payload.role === "assistant" ? "message" : "prompt");
    if (payload.role === "user" && isInjectedUserContext(text)) {
      continue;
    }
    if (payload.role === "user" && !firstUserMessage) {
      firstUserMessage = text;
      title = trimText(text, 72);
    }
    if (payload.role === "assistant") {
      lastAssistantMessage = text;
    }
    messages.push({
      id: payload.id || `${payload.role}_${messages.length}`,
      role: payload.role,
      phase,
      text,
      timestamp: formatTimestamp(record.timestamp)
    });
  }

  const parsed = {
    id: meta?.id || path.basename(filePath, ".jsonl"),
    title,
    cwd: meta?.cwd || "",
    backend: detectThreadBackend(filePath),
    source: meta?.source || "",
    cliVersion: meta?.cliVersion || "",
    createdAt: meta?.createdAt || null,
    updatedAt: stats.mtime.toISOString(),
    firstUserMessage,
    lastAssistantMessage,
    filePath,
    messages,
    summary: buildThreadSummary(
      {
        id: meta?.id || path.basename(filePath, ".jsonl"),
        title,
        cwd: meta?.cwd || "",
        backend: detectThreadBackend(filePath),
        source: meta?.source || "",
        cliVersion: meta?.cliVersion || "",
        createdAt: meta?.createdAt || null,
        updatedAt: stats.mtime.toISOString(),
        firstUserMessage,
        lastAssistantMessage
      },
      messages.length
    )
  };

  threadCache.set(filePath, {
    mtimeMs: stats.mtimeMs,
    parsed
  });
  return parsed;
}

async function loadThreadSummaries(limit = MAX_THREADS) {
  const indexEntries = [];
  for (const sessionIndexPath of getSessionIndexPaths()) {
    const raw = await readTextFile(sessionIndexPath);
    const parsedEntries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => safeJsonParse(line, null))
      .filter(Boolean);
    indexEntries.push(...parsedEntries);
  }

  const entries = indexEntries
    .sort((left, right) => new Date(right.updated_at || 0) - new Date(left.updated_at || 0))
    .slice(0, limit);

  const indexedIds = new Set(entries.map((entry) => entry.id));
  const summaries = [];
  for (const entry of entries) {
    const filePath = await ensureThreadFile(entry.id);
    if (!filePath) {
      summaries.push({
        id: entry.id,
        title: entry.thread_name || "Untitled thread",
        updatedAt: entry.updated_at || null,
        createdAt: null,
        cwd: "",
        backend: "windows",
        source: "",
        cliVersion: "",
        firstUserMessage: "",
        lastAssistantMessage: "",
        messageCount: 0
      });
      continue;
    }
    const parsed = await parseThreadFile(filePath);
    summaries.push({
      ...parsed.summary,
      title: entry.thread_name || parsed.summary.title,
      updatedAt: entry.updated_at || parsed.summary.updatedAt
    });
  }

  const extraIds = Array.from(sessionFileMap.entries())
    .filter(([threadId]) => !indexedIds.has(threadId))
    .sort((left, right) => path.basename(right[1]).localeCompare(path.basename(left[1])))
    .slice(0, limit);

  for (const [threadId, filePath] of extraIds) {
    const parsed = await parseThreadFile(filePath);
    summaries.push({
      ...parsed.summary,
      id: threadId
    });
  }

  return summaries
    .filter((thread) => !isInternalAutomationPrompt(thread.firstUserMessage || ""))
    .sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0))
    .slice(0, limit);
}

async function loadThreadDetail(threadId) {
  const filePath = await ensureThreadFile(threadId);
  if (!filePath) {
    return null;
  }
  return parseThreadFile(filePath);
}

function getPublicSettings() {
  return {
    workspaceRoots: settings.workspaceRoots,
    defaultWorkspaceRoot: settings.defaultWorkspaceRoot,
    notificationEnabled: settings.notificationEnabled,
    publicBaseUrl: settings.publicBaseUrl,
    tailscaleBaseUrl: settings.tailscaleBaseUrl,
    executionBackend: settings.executionBackend,
    wslDistroName: settings.wslDistroName,
    wslHomePath: settings.wslHomePath,
    discordChannelId: settings.discordChannelId,
    discordWebhookConfigured: Boolean(settings.discordWebhookUrl),
    discordWebhookUrl: settings.discordWebhookUrl,
    discordBotTokenConfigured: Boolean(settings.discordBotToken)
  };
}

async function buildPairingPayload() {
  const localhostUrl = `http://localhost:${PORT}`;
  const lanBaseUrls = getLanBaseUrls();
  const tailscaleBaseUrls = getTailscaleBaseUrls();
  const publicBaseUrl = normalizeBaseUrl(settings.publicBaseUrl);
  const tailscaleBaseUrl = normalizeBaseUrl(settings.tailscaleBaseUrl) || tailscaleBaseUrls[0] || "";
  const hasDetectedTailscale = tailscaleBaseUrls.length > 0;
  const hasConfiguredTailscale = Boolean(normalizeBaseUrl(settings.tailscaleBaseUrl));
  const rawLinks = [
    {
      id: "tailscale",
      label: "Tailscale",
      description: hasDetectedTailscale
        ? "Recommended for personal remote access. Scan this from a phone already connected to the same tailnet."
        : hasConfiguredTailscale
          ? "Configured Tailscale URL. This works only while the Codex PC is connected to Tailscale."
          : "Recommended for personal remote access when the Codex PC is connected to Tailscale.",
      baseUrl: tailscaleBaseUrl
    },
    {
      id: "lan",
      label: "Same Wi-Fi",
      description: "Scan this on a phone connected to the same local network as the Codex PC.",
      baseUrl: lanBaseUrls[0] || ""
    },
    {
      id: "public",
      label: "Public URL",
      description: "Use this only if your public domain or tunnel already points at the dashboard.",
      baseUrl: publicBaseUrl
    },
    {
      id: "local",
      label: "This PC",
      description: "Useful for quick copy-paste on the Codex machine itself.",
      baseUrl: localhostUrl
    }
  ];

  const links = [];
  const seen = new Set();

  for (const link of rawLinks) {
    const url = buildUrl(link.baseUrl, { token: settings.authToken });
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push({
      ...link,
      url,
      qrDataUrl: await QRCode.toDataURL(url, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 280
      })
    });
  }

  return {
    token: settings.authToken,
    publicBaseUrl,
    tailscaleBaseUrl,
    localhostUrl,
    lanBaseUrls,
    tailscaleBaseUrls,
    links
  };
}

function getJobsSnapshot() {
  return jobs
    .slice()
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .map((job) => ({
      id: job.id,
      status: job.status,
      workspaceRoot: job.workspaceRoot,
      executionBackend: job.executionBackend || "windows",
      promptPreview: trimText(job.prompt, 160),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      threadId: job.threadId,
      resumeThreadId: job.resumeThreadId || null,
      lastAssistantMessage: trimText(job.lastAssistantMessage || "", 280),
      error: job.error || "",
      stderrTail: trimText(job.stderr || "", 280)
    }));
}

function broadcast(event, payload) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(chunk);
  }
}

function quoteCmdArg(arg) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) {
    return arg;
  }
  return `"${String(arg).replace(/"/g, '""')}"`;
}

function quoteBashArg(arg) {
  return `'${String(arg).replace(/'/g, `'\"'\"'`)}'`;
}

function buildExecutionArgs() {
  if (EXECUTION_MODE === "sandboxed") {
    return ["-a", EXEC_APPROVAL, "-s", EXEC_SANDBOX];
  }
  return ["--dangerously-bypass-approvals-and-sandbox"];
}

function buildCodexArgs(job, nullDevice) {
  const executionArgs = buildExecutionArgs();
  return job.resumeThreadId
    ? [
        ...executionArgs,
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "-o",
        nullDevice,
        job.resumeThreadId,
        "-"
      ]
    : [
        ...executionArgs,
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-o",
        nullDevice,
        "-"
      ];
}

function buildCodexExecution(job) {
  if (job.executionBackend === "wsl") {
    const wslConfig = getWslConfig();
    const bashCommand = ["codex", ...buildCodexArgs(job, "/dev/null")]
      .map(quoteBashArg)
      .join(" ");
    return {
      command: "wsl.exe",
      args: ["-d", wslConfig.distroName, "--cd", job.workspaceRoot, "bash", "-lic", bashCommand],
      cwd: IS_WINDOWS_HOST ? LOCAL_HOME : DEFAULT_WORKSPACE
    };
  }

  const command = ["codex.cmd", ...buildCodexArgs(job, "NUL")]
    .map(quoteCmdArg)
    .join(" ");
  return {
    command: CMD_EXE,
    args: ["/d", "/s", "/c", command],
    cwd: job.workspaceRoot
  };
}

function toWslWorkspaceRoot(workspaceRoot) {
  const normalized = String(workspaceRoot || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("/")) {
    return normalized;
  }
  const driveMatch = normalized.match(/^([A-Za-z]):[\\/](.*)$/);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, "/")}`;
  }
  const uncMatch = normalized.match(/^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.+)$/i);
  if (uncMatch) {
    return `/${uncMatch[1].replace(/\\/g, "/")}`;
  }
  return normalized.replace(/\\/g, "/");
}

function toWindowsWorkspaceRoot(workspaceRoot) {
  const normalized = String(workspaceRoot || "").trim();
  if (!normalized) {
    return "";
  }
  if (/^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized;
  }
  const mountMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.+)$/);
  if (mountMatch) {
    return `${mountMatch[1].toUpperCase()}:\\${mountMatch[2].replace(/\//g, "\\")}`;
  }
  throw new Error("The selected workspace cannot be used with the Windows backend.");
}

function convertWorkspaceRootForBackend(workspaceRoot, executionBackend) {
  return normalizeExecutionBackend(executionBackend) === "wsl"
    ? toWslWorkspaceRoot(workspaceRoot)
    : toWindowsWorkspaceRoot(workspaceRoot);
}

function normalizeWorkspaceRoot(workspaceRoot, { allowUnlisted = false } = {}) {
  const trimmed = String(workspaceRoot || "").trim();
  if (!trimmed) {
    return settings.defaultWorkspaceRoot;
  }
  const listed = settings.workspaceRoots.find((item) => item === trimmed);
  if (listed) {
    return listed;
  }
  if (allowUnlisted) {
    return trimmed;
  }
  return settings.defaultWorkspaceRoot;
}

async function resolveJobSpec({ workspaceRoot, resumeThreadId = null }) {
  if (resumeThreadId) {
    const thread = await loadThreadDetail(resumeThreadId);
    if (!thread) {
      throw new Error("Thread not found");
    }
    const executionBackend = normalizeExecutionBackend(thread.backend || settings.executionBackend);
    const resolvedWorkspaceRoot = thread.cwd
      ? normalizeWorkspaceRoot(thread.cwd, {
        allowUnlisted: true
      })
      : normalizeWorkspaceRoot(workspaceRoot);
    return {
      workspaceRoot: convertWorkspaceRootForBackend(resolvedWorkspaceRoot, executionBackend),
      executionBackend
    };
  }
  const executionBackend = normalizeExecutionBackend(settings.executionBackend);
  return {
    workspaceRoot: convertWorkspaceRootForBackend(normalizeWorkspaceRoot(workspaceRoot), executionBackend),
    executionBackend
  };
}

function updateJob(jobId, patch) {
  const job = jobs.find((item) => item.id === jobId);
  if (!job) {
    return null;
  }
  Object.assign(job, patch);
  broadcast("jobs", getJobsSnapshot());
  return job;
}

async function notifyDiscord(job) {
  if (!settings.notificationEnabled) {
    return;
  }
  const dashboardUrl = buildDashboardUrl(job.threadId);
  const isCompleted = job.status === "completed";
  const lines = [isCompleted ? "스레드의 작업이 완료되었습니다." : "스레드의 작업이 실패했습니다."];
  lines.push(`Thread: ${job.threadId || job.id}`);
  lines.push(`Workspace: ${job.workspaceRoot}`);
  lines.push(`Dashboard: ${dashboardUrl}`);
  if (job.lastAssistantMessage) {
    lines.push(`Result: ${trimText(job.lastAssistantMessage, 900)}`);
  }
  if (job.error) {
    lines.push(`Error: ${trimText(job.error, 500)}`);
  }

  const content = lines.join("\n");
  try {
    if (settings.discordBotToken && settings.discordChannelId) {
      const response = await fetch(`https://discord.com/api/v10/channels/${settings.discordChannelId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${settings.discordBotToken}`
        },
        body: JSON.stringify({ content })
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord bot API returned ${response.status}: ${trimText(body, 240)}`);
      }
      return;
    }

    if (settings.discordWebhookUrl) {
      const response = await fetch(settings.discordWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ content })
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord webhook returned ${response.status}: ${trimText(body, 240)}`);
      }
      return;
    }

    updateJob(job.id, {
      stderr: `${job.stderr || ""}\nDiscord notification skipped: configure a webhook or bot channel.`.trim()
    });
  } catch (error) {
    updateJob(job.id, {
      stderr: `${job.stderr || ""}\nDiscord notification failed: ${error.message}`.trim()
    });
  }
}

async function finalizeJob(job, status) {
  await refreshSessionFileMap();
  let thread = null;
  if (job.threadId) {
    thread = await loadThreadDetail(job.threadId);
  }
  updateJob(job.id, {
    status,
    finishedAt: nowIso(),
    lastAssistantMessage: thread?.lastAssistantMessage || job.lastAssistantMessage || ""
  });
  if (thread) {
    broadcast("thread", thread);
  }
  broadcast("threads", await loadThreadSummaries());
  await notifyDiscord(jobs.find((item) => item.id === job.id));
}

async function runJob(job) {
  activeJobId = job.id;
  updateJob(job.id, {
    status: "running",
    startedAt: nowIso(),
    stderr: "",
    error: ""
  });

  const execution = buildCodexExecution(job);
  const child = spawn(execution.command, execution.args, {
    cwd: execution.cwd,
    env: {
      ...process.env,
      RUST_LOG: "error"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdin.write(job.prompt);
  child.stdin.end();

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const event = safeJsonParse(line, null);
      if (!event || typeof event !== "object") {
        continue;
      }
      if (event.type === "thread.started") {
        updateJob(job.id, { threadId: event.thread_id });
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        updateJob(job.id, { lastAssistantMessage: event.item.text || "" });
      }
      broadcast("job-event", {
        jobId: job.id,
        event
      });
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    updateJob(job.id, {
      stderr: trimText(stderrBuffer, 1600)
    });
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  if (stdoutBuffer.trim()) {
    const event = safeJsonParse(stdoutBuffer.trim(), null);
    if (event?.type === "item.completed" && event.item?.type === "agent_message") {
      updateJob(job.id, { lastAssistantMessage: event.item.text || "" });
    }
  }

  if (exitCode === 0) {
    await finalizeJob(job, "completed");
  } else {
    updateJob(job.id, {
      error: trimText(stderrBuffer || `Codex exited with code ${exitCode}`, 1000)
    });
    await finalizeJob(job, "failed");
  }
  activeJobId = null;
}

async function processQueue() {
  if (isProcessingQueue) {
    return;
  }
  isProcessingQueue = true;
  while (jobQueue.length) {
    const nextJobId = jobQueue.shift();
    const job = jobs.find((item) => item.id === nextJobId);
    if (!job) {
      continue;
    }
    await runJob(job);
  }
  isProcessingQueue = false;
}

function queueJob({ prompt, workspaceRoot, resumeThreadId = null }) {
  const job = {
    id: createId("job"),
    prompt,
    workspaceRoot,
    executionBackend: normalizeExecutionBackend(settings.executionBackend),
    resumeThreadId,
    status: "queued",
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    threadId: null,
    lastAssistantMessage: "",
    error: "",
    stderr: ""
  };
  jobs.push(job);
  jobQueue.push(job.id);
  broadcast("jobs", getJobsSnapshot());
  void processQueue();
  return job;
}

function validateSettingsUpdate(payload) {
  const next = {
    defaultWorkspaceRoot: settings.defaultWorkspaceRoot,
    notificationEnabled: settings.notificationEnabled,
    discordWebhookUrl: settings.discordWebhookUrl,
    discordBotToken: settings.discordBotToken,
    discordChannelId: settings.discordChannelId,
    publicBaseUrl: settings.publicBaseUrl,
    tailscaleBaseUrl: settings.tailscaleBaseUrl,
    executionBackend: settings.executionBackend,
    wslDistroName: settings.wslDistroName,
    wslHomePath: settings.wslHomePath
  };

  if (payload.defaultWorkspaceRoot && settings.workspaceRoots.includes(payload.defaultWorkspaceRoot)) {
    next.defaultWorkspaceRoot = payload.defaultWorkspaceRoot;
  }
  if (typeof payload.notificationEnabled === "boolean") {
    next.notificationEnabled = payload.notificationEnabled;
  }
  if (typeof payload.discordWebhookUrl === "string") {
    next.discordWebhookUrl = payload.discordWebhookUrl.trim();
  }
  if (typeof payload.discordBotToken === "string" && payload.discordBotToken.trim()) {
    next.discordBotToken = payload.discordBotToken.trim();
  }
  if (typeof payload.discordChannelId === "string") {
    next.discordChannelId = payload.discordChannelId.trim();
  }
  if (typeof payload.publicBaseUrl === "string") {
    next.publicBaseUrl = normalizeBaseUrl(payload.publicBaseUrl);
  }
  if (typeof payload.tailscaleBaseUrl === "string") {
    next.tailscaleBaseUrl = normalizeBaseUrl(payload.tailscaleBaseUrl);
  }
  if (typeof payload.executionBackend === "string") {
    next.executionBackend = normalizeExecutionBackend(payload.executionBackend);
  }
  if (typeof payload.wslDistroName === "string") {
    next.wslDistroName = payload.wslDistroName.trim() || DEFAULT_WSL_DISTRO_NAME;
  }
  if (typeof payload.wslHomePath === "string") {
    next.wslHomePath = normalizeWslHomePath(payload.wslHomePath);
  }
  return next;
}

async function serveStatic(res, urlPathname) {
  const relativePath = urlPathname === "/" ? "/index.html" : urlPathname;
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(STATIC_DIR, normalized);
  if (!(await fileExists(filePath))) {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": guessContentType(filePath),
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function isAuthorized(req, url) {
  const token = extractToken(req, url);
  return token && token === settings.authToken;
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      activeJobId
    });
  }

  if (url.pathname === "/api/pairing") {
    if (!isLocalRequest(req)) {
      return sendJson(res, 403, {
        error: "Pairing is available only from the local machine."
      });
    }
    if (req.method !== "GET") {
      return sendJson(res, 405, {
        error: "Method not allowed"
      });
    }
    return sendJson(res, 200, {
      pairing: await buildPairingPayload()
    });
  }

  if (url.pathname === "/api/pairing/regenerate") {
    if (!isLocalRequest(req)) {
      return sendJson(res, 403, {
        error: "Pairing is available only from the local machine."
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, {
        error: "Method not allowed"
      });
    }
    settings.authToken = crypto.randomBytes(24).toString("hex");
    await saveSettings();
    disconnectEventClients();
    return sendJson(res, 200, {
      pairing: await buildPairingPayload()
    });
  }

  if (!isAuthorized(req, url)) {
    return sendJson(res, 401, {
      error: "Unauthorized"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      settings: getPublicSettings(),
      jobs: getJobsSnapshot(),
      threads: await loadThreadSummaries()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/threads") {
    return sendJson(res, 200, {
      threads: await loadThreadSummaries()
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/threads/")) {
    const threadId = decodeURIComponent(url.pathname.split("/").pop());
    const thread = await loadThreadDetail(threadId);
    if (!thread) {
      return sendJson(res, 404, {
        error: "Thread not found"
      });
    }
    return sendJson(res, 200, {
      thread
    });
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    return sendJson(res, 200, {
      jobs: getJobsSnapshot()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({
      ok: true,
      jobs: getJobsSnapshot()
    })}\n\n`);
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/threads") {
    const body = await readJsonBody(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return sendJson(res, 400, {
        error: "Prompt is required"
      });
    }
    const resumeThreadId = body.resumeThreadId ? String(body.resumeThreadId).trim() : null;
    const jobSpec = await resolveJobSpec({
      workspaceRoot: String(body.workspaceRoot || settings.defaultWorkspaceRoot),
      resumeThreadId
    });
    const job = queueJob({
      prompt,
      workspaceRoot: jobSpec.workspaceRoot,
      resumeThreadId
    });
    job.executionBackend = jobSpec.executionBackend;
    return sendJson(res, 202, {
      job
    });
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    settings = {
      ...settings,
      ...validateSettingsUpdate(body)
    };
    await saveSettings();
    return sendJson(res, 200, {
      settings: getPublicSettings()
    });
  }

  return sendJson(res, 404, {
    error: "Not found"
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/pair" || url.pathname === "/pair.js") {
    if (!isLocalRequest(req)) {
      return sendText(res, 403, "Pairing is available only from the local machine.");
    }
    const staticPath = url.pathname === "/pair" ? "/pair.html" : url.pathname;
    const served = await serveStatic(res, staticPath);
    if (!served) {
      sendText(res, 404, "Not found");
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      sendJson(res, 500, {
        error: error.message
      });
    }
    return;
  }

  const served = await serveStatic(res, url.pathname);
  if (!served) {
    sendText(res, 404, "Not found");
  }
}

async function start() {
  await loadSettings();
  await refreshSessionFileMap();

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.listen(PORT, HOST, () => {
    const hostLabel = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log("");
    console.log("Codex remote dashboard");
    console.log(`URL: http://${hostLabel}:${PORT}`);
    console.log(`LAN: http://<this-pc-ip>:${PORT}`);
    console.log(`Access token: ${settings.authToken}`);
    console.log(`Saved settings: ${SETTINGS_PATH}`);
    console.log("");
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
