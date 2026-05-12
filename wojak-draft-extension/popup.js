let remoteConfig = {
  enabled: false,
  apiBaseUrl: ""
};

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

function formatSeconds(ms) {
  return `${Math.max(0, Math.ceil(Number(ms || 0) / 1000))} 秒`;
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

async function refreshRemoteConfig() {
  const response = await chrome.runtime.sendMessage({ type: "GET_REMOTE_MONITOR_CONFIG" });
  if (!response?.ok) {
    setRemoteStatus(response?.error || "监听配置读取失败", "error");
    return;
  }

  remoteConfig = {
    enabled: Boolean(response.config?.enabled),
    apiBaseUrl: response.config?.apiBaseUrl || "http://127.0.0.1:8787"
  };
  $("remoteApiBaseUrl").value = remoteConfig.apiBaseUrl;
  renderListenState();
  if (remoteConfig.enabled) {
    await checkRemoteTasks();
  }
}

async function checkRemoteTasks() {
  const response = await chrome.runtime.sendMessage({ type: "CHECK_REMOTE_TASKS" });
  if (!response?.ok) {
    setRemoteStatus(response?.error || "任务检查失败", "error");
    return;
  }

  if (response.result?.started) {
    setRemoteStatus("已接收到链接，正在开始操作。", "watching");
    await refreshMonitorStatus();
    return;
  }

  if (response.result?.reason === "waiting_target_interval") {
    setRemoteStatus(`监听中，目标任务间隔剩余 ${formatSeconds(response.result.waitMs)}。`, "watching");
    await refreshMonitorStatus();
    return;
  }

  if (response.result?.reason === "idle_scrolled") {
    setRemoteStatus("没有新链接，已执行首页滚动浏览。", "watching");
    await refreshMonitorStatus();
    return;
  }

  if (response.result?.idle) {
    setRemoteStatus("没有新链接，已执行首页随机点赞。", "watching");
    await refreshMonitorStatus();
    return;
  }

  renderListenState();
  await refreshMonitorStatus();
}

async function refreshMonitorStatus() {
  if (!remoteConfig.enabled) {
    setMonitorStatus("监听未启动");
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_REMOTE_MONITOR_STATUS" });
  if (!response?.ok) {
    setMonitorStatus(response?.error || "监听状态读取失败", "error");
    return;
  }

  const status = response.status || {};
  const checkText = status.nextCheckAt ? `下次监听检查：${formatSeconds(status.nextCheckAt - Date.now())}` : "下次监听检查：等待调度";
  const waitText = status.state === "waiting_target_interval" && status.waitMs
    ? `；三连间隔剩余：${formatSeconds(status.waitMs - Math.max(0, Date.now() - (status.updatedAt || Date.now())))}`
    : "";
  setMonitorStatus(`${checkText}${waitText}`, status.state || "watching");
}

async function toggleListening() {
  const nextEnabled = !remoteConfig.enabled;
  const apiBaseUrl = $("remoteApiBaseUrl").value.trim();

  if (nextEnabled && !apiBaseUrl) {
    setRemoteStatus("请先填写前端服务地址", "error");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "UPDATE_REMOTE_MONITOR_CONFIG",
    config: {
      enabled: nextEnabled,
      apiBaseUrl
    }
  });

  if (!response?.ok) {
    setRemoteStatus(response?.error || "监听状态切换失败", "error");
    return;
  }

  remoteConfig = {
    enabled: Boolean(response.config?.enabled),
    apiBaseUrl: response.config?.apiBaseUrl || apiBaseUrl
  };
  renderListenState();
  await refreshMonitorStatus();
}

document.addEventListener("DOMContentLoaded", async () => {
  $("listenBtn").addEventListener("click", toggleListening);
  await refreshRemoteConfig();
  await refreshAutoLikeStatus();
  await refreshMonitorStatus();
  setInterval(refreshAutoLikeStatus, 1000);
  setInterval(refreshMonitorStatus, 1000);
});
