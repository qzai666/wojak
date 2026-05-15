let remoteConfig = {
  enabled: false,
  apiBaseUrl: globalThis.WOJAK_EXTENSION_ENV?.apiBaseUrl || "",
  queueId: "default"
};

let queues = [{ id: "default", name: "默认队列" }];
let currentQueueTaskCount = 0;
let lastQueueTaskCountFetchAt = 0;
let popupRefreshTimer = null;
let popupRefreshInFlight = false;
let currentApiBaseUrl = "";

const DEFAULT_QUEUE_ID = "default";
const LAST_TARGET_ACTION_AT_KEY = "remoteTaskMonitorLastTargetActionAt";
const QUEUE_TASK_COUNT_CACHE_MS = 5000;
const TERMINAL_TASK_STATES = new Set(["replied", "spam_reply", "already_replied", "error", "done"]);

const $ = (id) => document.getElementById(id);

function setAutoLikeStatus(text, stateName = "") {
  const status = $("autoLikeStatus");
  status.textContent = text;
  status.dataset.state = stateName;
}

function setRemoteStatus(text, stateName = "") {
  const status = $("remoteStatus");
  status.textContent = text;
  status.dataset.state = stateName;
}

function setMonitorStatus(text, stateName = "") {
  const status = $("monitorStatus");
  status.textContent = text;
  status.dataset.state = stateName;
}

function setQueueHint(text) {
  $("queueHint").textContent = text;
}

function formatSeconds(ms) {
  return `${Math.max(0, Math.ceil(Number(ms || 0) / 1000))} 秒`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeLocalApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 本地 env 只负责提供扩展默认服务地址，面板里仍然允许手动改写。
const DEFAULT_API_BASE_URL = normalizeLocalApiBaseUrl(globalThis.WOJAK_EXTENSION_ENV?.apiBaseUrl || "http://localhost:8787/");

function applyExtensionVersion() {
  const version = chrome.runtime?.getManifest?.().version || "";
  $("versionText").textContent = version ? `v${version}` : "";
  document.title = version ? `Wojak Draft ${$("versionText").textContent}` : "Wojak Draft Assistant";
}

function actionStorageKey(baseKey, queueId) {
  return `${baseKey}:${queueId || DEFAULT_QUEUE_ID}`;
}

function actionIntervalStorageKey(key) {
  return `${key}:intervalMs`;
}

function getCurrentQueueId() {
  return $("queueId")?.value || remoteConfig.queueId || DEFAULT_QUEUE_ID;
}

function getApiBaseUrlFromTabUrl(tabUrl) {
  try {
    const url = new URL(String(tabUrl || ""));
    if (!/^https?:$/.test(url.protocol)) {
      return "";
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      return "";
    }
    return normalizeLocalApiBaseUrl(url.origin);
  } catch {
    return "";
  }
}

async function getCurrentTabApiBaseUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return getApiBaseUrlFromTabUrl(tab?.url);
  } catch {
    return "";
  }
}

// 未开启监听时优先拿当前活动页地址，已开启监听时展示当前实际生效地址。
async function syncRemoteApiBaseUrlInput() {
  const currentTabApiBaseUrl = await getCurrentTabApiBaseUrl();
  const apiBaseUrl = remoteConfig.enabled
    ? remoteConfig.apiBaseUrl || currentTabApiBaseUrl || DEFAULT_API_BASE_URL
    : currentTabApiBaseUrl || remoteConfig.apiBaseUrl || DEFAULT_API_BASE_URL;
  currentApiBaseUrl = apiBaseUrl;
  $("remoteApiBaseUrl").textContent = apiBaseUrl;
  return apiBaseUrl;
}

function getResolvedApiBaseUrl() {
  return currentApiBaseUrl || remoteConfig.apiBaseUrl || DEFAULT_API_BASE_URL;
}

function renderQueues() {
  const selectedQueueId = remoteConfig.queueId || "default";
  $("queueId").innerHTML = queues.map((queue) => {
    const stateText = queue.enabled === false ? "（已关闭）" : "（已启动）";
    return `<option value="${escapeHtml(queue.id)}">${escapeHtml(queue.name)}${stateText}</option>`;
  }).join("");
  $("queueId").value = queues.some((queue) => queue.id === selectedQueueId) ? selectedQueueId : queues[0]?.id || "default";
}

async function fetchCurrentQueueTaskCount(force = false) {
  const now = Date.now();
  if (!force && now - lastQueueTaskCountFetchAt < QUEUE_TASK_COUNT_CACHE_MS) {
    return currentQueueTaskCount;
  }

  const apiBaseUrl = getResolvedApiBaseUrl();
  if (!apiBaseUrl) {
    currentQueueTaskCount = 0;
    lastQueueTaskCountFetchAt = now;
    return currentQueueTaskCount;
  }

  try {
    const url = new URL(`${apiBaseUrl}/api/wojak/tasks`);
    url.searchParams.set("queueId", getCurrentQueueId());
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`任务读取失败：${response.status}`);
    }
    const payload = await response.json();
    currentQueueTaskCount = (payload.tasks || []).filter((task) => !TERMINAL_TASK_STATES.has(task.state)).length;
  } catch {
    currentQueueTaskCount = 0;
  }

  lastQueueTaskCountFetchAt = now;
  return currentQueueTaskCount;
}

async function fetchCurrentQueueActiveLocalTaskCount() {
  try {
    const stored = await chrome.storage.local.get("autoLikeTasks");
    const tasks = stored.autoLikeTasks || {};
    return Object.values(tasks).filter((task) => {
      return task && task.queueId === getCurrentQueueId() && !TERMINAL_TASK_STATES.has(task.state);
    }).length;
  } catch {
    return 0;
  }
}

async function getCurrentQueueWaitSeconds() {
  const queueId = getCurrentQueueId();
  const targetActionKey = actionStorageKey(LAST_TARGET_ACTION_AT_KEY, queueId);
  const stored = await chrome.storage.local.get([targetActionKey, actionIntervalStorageKey(targetActionKey)]);
  const lastActionAt = Number(stored[targetActionKey]) || 0;
  const intervalMs = Number(stored[actionIntervalStorageKey(targetActionKey)]) || 0;
  if (!lastActionAt || !intervalMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((intervalMs - (Date.now() - lastActionAt)) / 1000));
}

// 队列倒计时统一只读本地随机间隔，避免和后台状态里的 waitMs 两套口径互相打架。
async function refreshQueueHint(status = null, force = false, waitSeconds = null) {
  const taskCount = await fetchCurrentQueueTaskCount(force);
  const activeLocalTaskCount = await fetchCurrentQueueActiveLocalTaskCount();
  const currentWaitSeconds = waitSeconds ?? await getCurrentQueueWaitSeconds();

  if (!taskCount) {
    setQueueHint("检测当前队列有0个任务，暂无待执行任务");
    return;
  }

  if (activeLocalTaskCount > 0) {
    setQueueHint(`检测当前队列有${taskCount}个任务，当前有${activeLocalTaskCount}个任务执行中`);
    return;
  }

  if (currentWaitSeconds > 0) {
    setQueueHint(`检测当前队列有${taskCount}个任务，还有${currentWaitSeconds}s开始执行任务队列`);
    return;
  }

  if (status?.state === "waiting_target_interval") {
    setQueueHint(`检测当前队列有${taskCount}个任务，随机间隔已结束，等待下次监听检查执行`);
    return;
  }

  setQueueHint(`检测当前队列有${taskCount}个任务，等待调度执行`);
}

async function refreshQueues() {
  const apiBaseUrl = getResolvedApiBaseUrl();
  try {
    const response = await fetch(`${apiBaseUrl}/api/wojak/queues`);
    if (!response.ok) {
      throw new Error(`队列读取失败：${response.status}`);
    }
    const payload = await response.json();
    queues = payload.queues?.length ? payload.queues : queues;
  } catch {
    queues = queues.length ? queues : [{ id: "default", name: "默认队列" }];
  }
  renderQueues();
  await refreshQueueHint(null, true);
}

function renderListenState() {
  const enabled = Boolean(remoteConfig.enabled);
  $("listenBtn").textContent = enabled ? "监听中，点击结束" : "开始监听";
  $("listenBadge").textContent = enabled ? "监听中" : "静默";
  $("listenBadge").dataset.state = enabled ? "watching" : "";
  setRemoteStatus(
    enabled ? "正在监听前端服务；无任务时会浏览首页随机点赞。" : "当前处于静默状态",
    enabled ? "watching" : ""
  );
  if (!enabled) {
    setMonitorStatus("监听未启动");
  }
}

function describeAutoLikeTask(task) {
  if (!task) {
    return ["暂无执行中的任务", ""];
  }

  const states = {
    opening: "正在打开目标链接…",
    watching: "正在监听目标帖子…",
    refreshing: "目标帖子未就绪，正在刷新重试…",
    liking: "正在点赞…",
    liked: "已点赞",
    already_liked: "已是点赞状态",
    reposting: "正在转发…",
    reposted: "已转发",
    already_reposted: "已是转发状态",
    composing: "正在填写评论…",
    uploading_image: "正在附加图片…",
    waiting_image: "正在等待图片上传…",
    publishing: "正在发布评论…",
    replied: "评论已发布，结果已回传",
    spam_reply: "评论已发布，但可能被折叠为垃圾贴",
    already_replied: "已评论过，结果已回传",
    error: task.error ? `执行失败：${task.error}` : "执行失败"
  };
  return [states[task.state] || "任务执行中…", task.state || ""];
}

async function refreshAutoLikeStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setAutoLikeStatus("暂无执行中的任务");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_AUTO_LIKE_STATUS",
    tabId: tab.id
  });

  if (!response?.ok) {
    setAutoLikeStatus(response?.error || "执行状态读取失败", "error");
    return;
  }

  const [text, stateName] = describeAutoLikeTask(response.task);
  setAutoLikeStatus(text, stateName);
}

// 弹窗只保留一个 1 秒刷新节拍，并发中的请求不再重复发起。
async function refreshPopupState(force = false) {
  if (popupRefreshInFlight) {
    return;
  }

  popupRefreshInFlight = true;
  try {
    await syncRemoteApiBaseUrlInput();
    await refreshAutoLikeStatus();
    await refreshMonitorStatus(force);
  } finally {
    popupRefreshInFlight = false;
  }
}

async function refreshRemoteConfig() {
  const window = await chrome.windows.getCurrent();
  const response = await chrome.runtime.sendMessage({
    type: "GET_REMOTE_MONITOR_CONFIG",
    windowId: window.id
  });
  if (!response?.ok) {
    setRemoteStatus(response?.error || "监听配置读取失败", "error");
    return;
  }

  remoteConfig = {
    enabled: Boolean(response.config?.enabled),
    apiBaseUrl: response.config?.apiBaseUrl || DEFAULT_API_BASE_URL,
    queueId: response.config?.queueId || "default"
  };
  await syncRemoteApiBaseUrlInput();
  await refreshQueues();
  renderListenState();
  if (remoteConfig.enabled) {
    await checkRemoteTasks();
    return;
  }
  await refreshPopupState(true);
}

async function checkRemoteTasks() {
  const window = await chrome.windows.getCurrent();
  const response = await chrome.runtime.sendMessage({
    type: "CHECK_REMOTE_TASKS",
    windowId: window.id
  });
  if (!response?.ok) {
    setRemoteStatus(response?.error || "任务检查失败", "error");
    return;
  }

  if (response.result?.started) {
    setRemoteStatus("已接收到链接，正在开始操作。", "watching");
    await refreshPopupState(true);
    return;
  }

  if (response.result?.reason === "waiting_target_interval") {
    setRemoteStatus(`监听中，目标任务间隔剩余 ${formatSeconds(response.result.waitMs)}。`, "watching");
    await refreshPopupState(true);
    return;
  }

  if (response.result?.reason === "idle_scrolled") {
    setRemoteStatus("没有新链接，已执行首页滚动浏览。", "watching");
    await refreshPopupState(true);
    return;
  }

  if (response.result?.idle) {
    setRemoteStatus("没有新链接，已执行首页随机点赞。", "watching");
    await refreshPopupState(true);
    return;
  }

  renderListenState();
  await refreshPopupState(true);
}

async function refreshMonitorStatus(force = false) {
  if (!remoteConfig.enabled) {
    setMonitorStatus("监听未启动");
    await refreshQueueHint(null, force);
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_REMOTE_MONITOR_STATUS" });
  if (!response?.ok) {
    setMonitorStatus(response?.error || "监听状态读取失败", "error");
    await refreshQueueHint(null, force);
    return;
  }

  const status = response.status || {};
  const waitSeconds = await getCurrentQueueWaitSeconds();
  const checkText = status.nextCheckAt ? `下次监听检查：${formatSeconds(status.nextCheckAt - Date.now())}` : "下次监听检查：等待调度";
  const waitText = status.state !== "waiting_target_interval"
    ? ""
    : waitSeconds > 0
      ? `；三连间隔剩余：${formatSeconds(waitSeconds * 1000)}`
      : "；三连间隔已结束，等待下次监听检查";
  setMonitorStatus(`${checkText}${waitText}`, status.state || "watching");
  await refreshQueueHint(status, force, waitSeconds);
}

async function toggleListening() {
  const nextEnabled = !remoteConfig.enabled;
  const apiBaseUrl = await syncRemoteApiBaseUrlInput();
  const queueId = $("queueId").value;
  const window = await chrome.windows.getCurrent();

  if (nextEnabled && !apiBaseUrl) {
    setRemoteStatus("请先填写前端服务地址", "error");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "UPDATE_REMOTE_MONITOR_CONFIG",
    config: {
      enabled: nextEnabled,
      apiBaseUrl,
      queueId,
      windowId: window.id
    }
  });

  if (!response?.ok) {
    setRemoteStatus(response?.error || "监听状态切换失败", "error");
    return;
  }

  remoteConfig = {
    enabled: Boolean(response.config?.enabled),
    apiBaseUrl: response.config?.apiBaseUrl || apiBaseUrl,
    queueId: response.config?.queueId || queueId
  };
  renderListenState();
  await refreshPopupState(true);
}

async function updateQueueBinding() {
  if (!remoteConfig.enabled) {
    remoteConfig.queueId = $("queueId").value;
    await refreshQueueHint(null, true);
    return;
  }

  const window = await chrome.windows.getCurrent();
  const apiBaseUrl = await syncRemoteApiBaseUrlInput();
  const queueId = $("queueId").value;
  const response = await chrome.runtime.sendMessage({
    type: "UPDATE_REMOTE_MONITOR_CONFIG",
    config: {
      enabled: true,
      apiBaseUrl,
      queueId,
      windowId: window.id
    }
  });

  if (!response?.ok) {
    setRemoteStatus(response?.error || "窗口队列更新失败", "error");
    return;
  }

  remoteConfig = {
    enabled: true,
    apiBaseUrl: response.config?.apiBaseUrl || apiBaseUrl,
    queueId: response.config?.queueId || queueId
  };
  renderQueues();
  await refreshPopupState(true);
}

document.addEventListener("DOMContentLoaded", async () => {
  applyExtensionVersion();
  $("listenBtn").addEventListener("click", toggleListening);
  $("queueId").addEventListener("change", updateQueueBinding);
  await refreshRemoteConfig();
  await refreshPopupState(true);
  popupRefreshTimer = window.setInterval(() => {
    refreshPopupState().catch(() => {});
  }, 1000);
});
