const TASKS_KEY = "autoLikeTasks";
const REMOTE_CONFIG_KEY = "remoteTaskMonitorConfig";
const REMOTE_POLL_ALARM = "remoteTaskPoll";
const LAST_TARGET_ACTION_AT_KEY = "remoteTaskMonitorLastTargetActionAt";
const LAST_IDLE_ACTION_AT_KEY = "remoteTaskMonitorLastIdleActionAt";
const MONITOR_STATUS_KEY = "remoteTaskMonitorStatus";
const ACTION_INTERVAL_MS = 2 * 60 * 1000;
const ACTION_INTERVAL_MINUTES = 2;
const POLL_INTERVAL_MS = 30 * 1000;
const POLL_INTERVAL_MINUTES = 0.5;
const HOME_URL = "https://x.com/home";
const TERMINAL_STATES = new Set(["replied", "already_replied", "error"]);

const defaultComments = [
  "三箭齐发，直指Billion、ETH这边，$Wojak扛的是OG Meme回归的大旗",
  "真正的 $Wojak 只存在于 ETH 主网。底部越来越高，兄弟，蹲好位置慢慢拿。",
  "研究得越深，越敢下重注。OG Meme 叙事还没结束，Study $Wojak",
  "种子是多年前种下的。现在，是到了它破土而出的时候了。$Wojak",
  "Wojak在熊市里哭了，但以太坊上的 $Wojak 就是他现在微笑的理由。"
];

const defaultEndings = [
  "真正的OG叙事会自己说话。",
  "ETH主网上的老叙事，值得继续Study。",
  "别只看一根K，$Wojak 的位置要放到周期里看。",
  "底部耐心比追高更重要，Study $Wojak."
];

const imageAssetPaths = [
  "assets/photo_2026-05-12_10-29-38.jpg",
  "assets/photo_2026-05-12_10-30-09.jpg",
  "assets/photo_2026-05-12_10-30-15.jpg",
  "assets/photo_2026-05-12_10-30-19.jpg",
  "assets/photo_2026-05-12_10-30-25.jpg",
  "assets/photo_2026-05-12_10-30-28.jpg",
  "assets/photo_2026-05-12_10-30-32.jpg",
  "assets/photo_2026-05-12_10-30-36.jpg",
  "assets/photo_2026-05-12_10-30-40.jpg",
  "assets/photo_2026-05-12_10-30-44.jpg",
  "assets/photo_2026-05-12_10-30-48.jpg",
  "assets/photo_2026-05-12_10-30-51.jpg",
  "assets/photo_2026-05-12_10-30-55.jpg",
  "assets/photo_2026-05-12_10-30-58.jpg",
  "assets/photo_2026-05-12_10-31-09.jpg",
  "assets/photo_2026-05-12_10-31-12.jpg",
  "assets/photo_2026-05-12_10-31-16.jpg",
  "assets/photo_2026-05-12_10-31-19.jpg",
  "assets/photo_2026-05-12_10-31-23.jpg",
  "assets/photo_2026-05-12_10-31-26.jpg",
  "assets/photo_2026-05-12_10-31-29.jpg",
  "assets/photo_2026-05-12_10-31-33.jpg",
  "assets/photo_2026-05-12_10-31-52.jpg",
  "assets/photo_2026-05-12_10-31-56.jpg",
  "assets/photo_2026-05-12_10-32-01.jpg",
  "assets/photo_2026-05-12_10-32-04.jpg",
  "assets/photo_2026-05-12_10-32-07.jpg",
  "assets/photo_2026-05-12_10-32-11.jpg",
  "assets/photo_2026-05-12_10-32-14.jpg",
  "assets/photo_2026-05-12_10-32-17.jpg"
];

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function ensureKeyword(text) {
  return /\$wojak/i.test(text) ? text : `${text} $Wojak`;
}

function polish(text) {
  const normalized = ensureKeyword(String(text || "").replace(/\$WOJAK/g, "$Wojak").replace(/\s+/g, " ").trim());
  const result = `${normalized} ${pick(defaultEndings)}`;
  return ensureKeyword(result).replace(/\$Wojak\s+\$Wojak/g, "$Wojak");
}

function normalizeXUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hostname = "x.com";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function getStatusId(url) {
  const match = String(url).match(/\/status\/(\d+)/);
  return match ? match[1] : "";
}

async function getTasks() {
  const stored = await chrome.storage.local.get(TASKS_KEY);
  return stored[TASKS_KEY] || {};
}

async function setTasks(tasks) {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}

async function getRemoteConfig() {
  const stored = await chrome.storage.local.get(REMOTE_CONFIG_KEY);
  return {
    enabled: false,
    apiBaseUrl: "",
    pollMinutes: ACTION_INTERVAL_MINUTES,
    ...(stored[REMOTE_CONFIG_KEY] || {})
  };
}

async function setRemoteConfig(config) {
  const nextConfig = {
    enabled: Boolean(config.enabled),
    apiBaseUrl: String(config.apiBaseUrl || "").trim().replace(/\/+$/, ""),
    pollMinutes: ACTION_INTERVAL_MINUTES
  };
  await chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: nextConfig });
  if (nextConfig.enabled) {
    await chrome.storage.local.remove(LAST_TARGET_ACTION_AT_KEY);
  }
  await scheduleRemotePoll(nextConfig);
  if (nextConfig.enabled && nextConfig.apiBaseUrl) {
    checkRemoteTasks().catch((error) => {
      chrome.storage.local.set({
        remoteTaskMonitorLastError: error.message,
        remoteTaskMonitorLastErrorAt: Date.now()
      });
    });
  }
  return nextConfig;
}

async function scheduleRemotePoll(config = null) {
  const nextConfig = config || await getRemoteConfig();
  await chrome.alarms.clear(REMOTE_POLL_ALARM);
  if (!nextConfig.enabled || !nextConfig.apiBaseUrl) {
    await setMonitorStatus({ state: "silent", message: "当前处于静默状态" });
    return;
  }

  chrome.alarms.create(REMOTE_POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: POLL_INTERVAL_MINUTES
  });
  await setMonitorStatus({
    state: "watching",
    message: "正在监听前端服务",
    nextCheckAt: Date.now() + 0.1 * 60 * 1000
  });
}

async function setMonitorStatus(patch) {
  const stored = await chrome.storage.local.get(MONITOR_STATUS_KEY);
  const status = {
    ...(stored[MONITOR_STATUS_KEY] || {}),
    ...patch,
    updatedAt: Date.now()
  };
  if (!Object.prototype.hasOwnProperty.call(patch, "waitMs")) {
    delete status.waitMs;
  }
  await chrome.storage.local.set({ [MONITOR_STATUS_KEY]: status });
  return status;
}

async function getMonitorStatus() {
  const stored = await chrome.storage.local.get(MONITOR_STATUS_KEY);
  return stored[MONITOR_STATUS_KEY] || {};
}

async function getLastActionAt(key) {
  const stored = await chrome.storage.local.get(key);
  return Number(stored[key]) || 0;
}

async function markActionStarted(key) {
  await chrome.storage.local.set({ [key]: Date.now() });
}

async function getActionWaitMs(key) {
  const lastActionAt = await getLastActionAt(key);
  return Math.max(0, ACTION_INTERVAL_MS - (Date.now() - lastActionAt));
}

async function canStartAction(key) {
  const lastActionAt = await getLastActionAt(key);
  return Date.now() - lastActionAt >= ACTION_INTERVAL_MS;
}

async function hasRunningTask() {
  const tasks = await getTasks();
  return Object.values(tasks).some((task) => task && !TERMINAL_STATES.has(task.state));
}

async function getOrCreateXTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*"] });
  const homeTab = tabs.find((tab) => tab.url === HOME_URL);
  if (homeTab?.id) {
    return homeTab;
  }
  if (tabs[0]?.id) {
    return tabs[0];
  }
  return chrome.tabs.create({ url: HOME_URL, active: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTabMessageWithRetry(tabId, message, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response?.ok) {
        return response;
      }
    } catch {
      // 页面刚打开时 content script 可能还没注入，短暂等待后重试。
    }
    await delay(1000);
  }
  return { ok: false, error: "Content script is not ready" };
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function browseHome({ shouldLike }) {
  const tab = await getOrCreateXTab();
  const shouldOpenHome = tab.url !== HOME_URL;
  if (shouldOpenHome) {
    await chrome.tabs.update(tab.id, { url: HOME_URL, active: true });
    await waitForTabComplete(tab.id);
    await delay(1500);
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }

  if (shouldLike) {
    await markActionStarted(LAST_IDLE_ACTION_AT_KEY);
  }
  const response = await sendTabMessageWithRetry(tab.id, {
    type: "BROWSE_HOME",
    shouldLike
  });
  await chrome.storage.local.set({
    remoteTaskMonitorLastIdleAt: Date.now(),
    remoteTaskMonitorLastIdleResult: response
  });
  return response;
}

function remoteHeaders(config) {
  return { Accept: "application/json" };
}

function remoteUrl(config, path) {
  return `${config.apiBaseUrl}${path}`;
}

function normalizeRemoteTask(remoteTask) {
  const imageAssetPath = remoteTask.imageAssetPath || pick(imageAssetPaths);
  return {
    remoteTaskId: String(remoteTask.id || ""),
    targetUrl: remoteTask.targetUrl || remoteTask.url || "",
    commentText: ensureKeyword(remoteTask.commentText || polish(pick(defaultComments))),
    imageAssetPath,
    imageFileName: remoteTask.imageFileName || imageAssetPath.split("/").pop() || ""
  };
}

async function fetchRemoteTask(config) {
  const url = new URL(remoteUrl(config, "/api/wojak/tasks/next"));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: remoteHeaders(config)
  });
  if (!response.ok) {
    throw new Error(`Remote task fetch failed: ${response.status}`);
  }

  const payload = await response.json();
  return payload.task || null;
}

async function hasPendingRemoteTask(config) {
  const response = await fetch(remoteUrl(config, "/api/wojak/tasks"), {
    method: "GET",
    headers: remoteHeaders(config)
  });
  if (!response.ok) {
    throw new Error(`Remote task list failed: ${response.status}`);
  }

  const payload = await response.json();
  return (payload.tasks || []).some((task) => task.state === "pending");
}

async function reportRemoteResult(task) {
  const config = await getRemoteConfig();
  if (!config.apiBaseUrl || !task.remoteTaskId) {
    return;
  }

  await fetch(remoteUrl(config, `/api/wojak/tasks/${encodeURIComponent(task.remoteTaskId)}/result`), {
    method: "POST",
    headers: {
      ...remoteHeaders(config),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      state: task.state,
      error: task.error || "",
      targetUrl: task.targetUrl,
      commentedUrl: task.commentedUrl || task.replyUrl || "",
      replyUrl: task.replyUrl || task.commentedUrl || "",
      statusId: task.statusId,
      completedAt: new Date().toISOString()
    })
  });
}

async function checkRemoteTasks() {
  const config = await getRemoteConfig();
  const nextCheckAt = Date.now() + POLL_INTERVAL_MS;
  if (!config.enabled || !config.apiBaseUrl || await hasRunningTask()) {
    const result = { started: false, reason: "not_ready", nextCheckAt };
    await setMonitorStatus({
      state: "watching",
      message: "监听中，当前有任务正在执行或配置未就绪",
      nextCheckAt
    });
    return result;
  }

  const hasPendingTask = await hasPendingRemoteTask(config);
  if (!hasPendingTask) {
    if (!await canStartAction(LAST_IDLE_ACTION_AT_KEY)) {
      const idleResult = await browseHome({ shouldLike: false });
      const result = { started: false, reason: "idle_scrolled", idleResult, nextCheckAt };
      await setMonitorStatus({
        state: "idle_scrolled",
        message: "没有新链接，已执行首页滚动浏览",
        nextCheckAt
      });
      return result;
    }

    const idleResult = await browseHome({ shouldLike: true });
    const result = { started: false, idle: true, idleResult, nextCheckAt };
    await setMonitorStatus({
      state: "idle_liked",
      message: "没有新链接，已执行首页随机点赞",
      nextCheckAt
    });
    return result;
  }

  if (!await canStartAction(LAST_TARGET_ACTION_AT_KEY)) {
    const waitMs = await getActionWaitMs(LAST_TARGET_ACTION_AT_KEY);
    const result = { started: false, reason: "waiting_target_interval", waitMs, nextCheckAt };
    await setMonitorStatus({
      state: "waiting_target_interval",
      message: "监听中，等待目标任务 2 分钟间隔结束",
      waitMs,
      nextCheckAt
    });
    return result;
  }

  const remoteTask = await fetchRemoteTask(config);
  if (!remoteTask) {
    const idleResult = await browseHome({ shouldLike: false });
    const result = { started: false, reason: "idle_scrolled", idleResult, nextCheckAt };
    await setMonitorStatus({
      state: "idle_scrolled",
      message: "没有新链接，已执行首页滚动浏览",
      nextCheckAt
    });
    return result;
  }

  const task = normalizeRemoteTask(remoteTask);
  if (!task.remoteTaskId || !task.targetUrl) {
    throw new Error("Remote task must include id and targetUrl");
  }

  const tab = await getOrCreateXTab();
  await markActionStarted(LAST_TARGET_ACTION_AT_KEY);
  const startedTask = await startAutoLike({
    tabId: tab.id,
    ...task,
    source: "remote"
  });
  const result = { started: true, task: startedTask, nextCheckAt };
  await setMonitorStatus({
    state: "started",
    message: "已接收到链接，正在开始操作",
    nextCheckAt
  });
  return result;
}

async function startAutoLike({ tabId, targetUrl, commentText, imageAssetPath, imageFileName, remoteTaskId, source }) {
  if (!tabId || !targetUrl) {
    throw new Error("Missing tabId or targetUrl");
  }

  const normalizedUrl = normalizeXUrl(targetUrl);
  const statusId = getStatusId(normalizedUrl);
  if (!statusId) {
    throw new Error("Target URL is not an X status URL");
  }

  const tasks = await getTasks();
  tasks[String(tabId)] = {
    targetUrl: normalizedUrl,
    statusId,
    commentText: String(commentText || "").trim(),
    imageAssetPath: imageAssetPath || "",
    imageFileName: imageFileName || "",
    remoteTaskId: remoteTaskId || "",
    source: source || "manual",
    startedAt: Date.now(),
    state: "opening"
  };
  await setTasks(tasks);

  const tab = await chrome.tabs.get(tabId);
  if (getStatusId(tab.url) === statusId) {
    await chrome.tabs.reload(tabId);
    await chrome.tabs.update(tabId, { active: true });
  } else {
    await chrome.tabs.update(tabId, { url: normalizedUrl, active: true });
  }

  return tasks[String(tabId)];
}

async function clearAutoLike(tabId) {
  const tasks = await getTasks();
  delete tasks[String(tabId)];
  await setTasks(tasks);
}

async function updateTaskState(tabId, patch) {
  const tasks = await getTasks();
  const key = String(tabId);
  if (!tasks[key]) {
    return;
  }
  const nextTask = {
    ...tasks[key],
    ...patch,
    updatedAt: Date.now()
  };
  tasks[key] = nextTask;
  await setTasks(tasks);

  if (TERMINAL_STATES.has(nextTask.state) && nextTask.remoteTaskId && !nextTask.resultReported) {
    tasks[key] = {
      ...nextTask,
      resultReported: true
    };
    await setTasks(tasks);
    try {
      await reportRemoteResult(tasks[key]);
    } catch (error) {
      await chrome.storage.local.set({
        remoteTaskMonitorLastError: error.message,
        remoteTaskMonitorLastErrorAt: Date.now()
      });
    }
    await chrome.tabs.update(Number(tabId), { url: HOME_URL, active: true });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "START_AUTO_LIKE") {
      sendResponse({ ok: true, task: await startAutoLike(message) });
      return;
    }

    if (message?.type === "GET_AUTO_LIKE_TASK") {
      const tasks = await getTasks();
      sendResponse({ ok: true, task: tasks[String(sender.tab?.id)] || null });
      return;
    }

    if (message?.type === "UPDATE_AUTO_LIKE_TASK") {
      await updateTaskState(sender.tab?.id, message.patch || {});
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "CLEAR_AUTO_LIKE_TASK") {
      await clearAutoLike(sender.tab?.id);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "GET_AUTO_LIKE_STATUS") {
      const tasks = await getTasks();
      sendResponse({ ok: true, task: tasks[String(message.tabId)] || null });
      return;
    }

    if (message?.type === "GET_REMOTE_MONITOR_CONFIG") {
      sendResponse({ ok: true, config: await getRemoteConfig() });
      return;
    }

    if (message?.type === "GET_REMOTE_MONITOR_STATUS") {
      sendResponse({ ok: true, status: await getMonitorStatus() });
      return;
    }

    if (message?.type === "UPDATE_REMOTE_MONITOR_CONFIG") {
      sendResponse({ ok: true, config: await setRemoteConfig(message.config || {}) });
      return;
    }

    if (message?.type === "CHECK_REMOTE_TASKS") {
      sendResponse({ ok: true, result: await checkRemoteTasks() });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearAutoLike(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REMOTE_POLL_ALARM) {
    return;
  }

  checkRemoteTasks().catch((error) => {
    chrome.storage.local.set({
      remoteTaskMonitorLastError: error.message,
      remoteTaskMonitorLastErrorAt: Date.now()
    });
  });
});

scheduleRemotePoll();
