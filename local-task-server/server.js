const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);

const tasks = [];
const results = [];
const queues = [{ id: "default", name: "默认队列", enabled: true, testMode: false }];
let gossipOriginalRound = 0;
const COMMENTS_PATH = path.resolve(__dirname, "../comments.json");
const ORIGINAL_PATH = path.resolve(__dirname, "../Original.json");
const GOSSIP_ORIGINAL_PATH = path.resolve(__dirname, "../gpt-image2/Original-prompts.json");
const IMAGE_DIR = path.resolve(__dirname, "../image");
const GOSSIP_IMAGE_DIR = path.resolve(__dirname, "../gpt-image2/image");
const DEFAULT_QUEUE_ID = queues[0].id;
// 服务端 running 任务回收超时，超过后会释放给下一轮重新调度。
const RUNNING_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL_TASK_STATES = new Set(["replied", "spam_reply", "already_replied", "error", "done"]);

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(html);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

function sendOptions(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400"
  });
  response.end();
}

function sendFile(response, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp"
  };
  response.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  fs.createReadStream(filePath).pipe(response);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeQueueId(value) {
  const queueId = String(value || DEFAULT_QUEUE_ID).trim();
  return queues.some((queue) => queue.id === queueId) ? queueId : DEFAULT_QUEUE_ID;
}

function queueLabel(queueId) {
  return queues.find((queue) => queue.id === queueId)?.name || queueId;
}

function cleanCommentText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createQueue(payload) {
  const name = String(payload.name || "").trim();
  return {
    id: crypto.randomUUID(),
    name: name || `队列 ${queues.length + 1}`,
    enabled: true,
    testMode: false
  };
}

function createTask(payload) {
  return {
    id: crypto.randomUUID(),
    type: payload.type || "engagement",
    queueId: normalizeQueueId(payload.queueId),
    targetUrl: String(payload.targetUrl || payload.url || "").trim(),
    commentText: cleanCommentText(payload.commentText),
    originalText: cleanCommentText(payload.originalText),
    imageAssetPath: String(payload.imageAssetPath || "").trim(),
    imageFileName: String(payload.imageFileName || "").trim(),
    state: "pending",
    copiedAt: "",
    createdAt: new Date().toISOString()
  };
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function loadRandomComment() {
  const comments = JSON.parse(fs.readFileSync(COMMENTS_PATH, "utf8"));
  const item = pick(comments);
  return cleanCommentText(item?.content);
}

function loadRandomOriginal() {
  const originals = JSON.parse(fs.readFileSync(ORIGINAL_PATH, "utf8"));
  const item = pick(originals);
  return cleanCommentText(item?.content);
}

function fitTweetText(text, maxLength = 280) {
  const normalized = cleanCommentText(text);
  if ([...normalized].length <= maxLength) {
    return normalized;
  }
  return [...normalized].slice(0, maxLength - 1).join("").replace(/[，。；、\s]+$/u, "").trim();
}

function getGossipImageFileName(item) {
  return String(item?.imageFileName || path.basename(item?.imageAssetPath || "")).trim();
}

function hasGossipImage(item) {
  const imageFileName = getGossipImageFileName(item);
  if (!imageFileName) {
    return false;
  }
  const imagePath = path.resolve(GOSSIP_IMAGE_DIR, imageFileName);
  return imagePath.startsWith(`${GOSSIP_IMAGE_DIR}${path.sep}`) && fs.existsSync(imagePath);
}

function loadGossipOriginal(request, index = null) {
  const originals = JSON.parse(fs.readFileSync(GOSSIP_ORIGINAL_PATH, "utf8")).filter(hasGossipImage);
  const item = Number.isInteger(index) ? originals[index % originals.length] : pick(originals);
  const origin = `http://${request.headers.host}`;
  const imageFileName = getGossipImageFileName(item);
  const title = cleanCommentText(item?.title_cn || item?.title_en || "AI 图片灵感");
  const sourceText = cleanCommentText(item?.finalContent || item?.content || "");

  return {
    // 八卦原创贴的发帖文案直接读取 JSON 中已整理好的最终文案。
    originalText: fitTweetText(sourceText || title),
    imageAssetPath: imageFileName ? `${origin}/gpt-image2/image/${encodeURIComponent(imageFileName)}` : "",
    imageFileName
  };
}

function loadRandomImageUrl(request) {
  const files = fs.readdirSync(IMAGE_DIR).filter((file) => /\.(jpe?g|png|gif|webp)$/i.test(file));
  const fileName = pick(files);
  const origin = `http://${request.headers.host}`;
  return {
    imageAssetPath: `${origin}/image/${encodeURIComponent(fileName)}`,
    imageFileName: fileName
  };
}

function isTaskActive(task) {
  return Boolean(task) && task.state !== "pending" && !TERMINAL_TASK_STATES.has(task.state);
}

function releaseStaleRunningTasks(queueId = null) {
  const now = Date.now();
  tasks.forEach((task) => {
    if (!isTaskActive(task) || (queueId && task.queueId !== queueId)) {
      return;
    }
    const lastHeartbeatAt = new Date(task.heartbeatAt || task.updatedAt || task.startedAt || task.createdAt || 0).getTime();
    if (!lastHeartbeatAt || now - lastHeartbeatAt < RUNNING_TASK_TIMEOUT_MS) {
      return;
    }
    task.state = "pending";
    task.error = "运行超时，已重新排队";
    task.startedAt = "";
    task.heartbeatAt = "";
    task.updatedAt = new Date().toISOString();
    task.retryCount = (Number(task.retryCount) || 0) + 1;
  });
}

function renderHomePage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Wojak Task Console</title>
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: #e5e7eb;
        background: #090b10;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(1180px, calc(100vw - 28px));
        margin: 26px auto;
      }

      header {
        display: flex;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 18px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
      }

      .subtitle {
        margin: 6px 0 0;
        color: #8b95a7;
      }

      .input-panel,
      .table-panel {
        border: 1px solid #232a36;
        border-radius: 8px;
        background: #11151d;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
      }

      .input-panel {
        padding: 16px;
      }

      form {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }

      input,
      select,
      button {
        min-height: 40px;
        border: 1px solid #2c3545;
        border-radius: 7px;
        font: inherit;
      }

      input,
      select {
        width: 100%;
        padding: 0 12px;
        color: #f4f7fb;
        background: #0b0f16;
      }

      input::placeholder {
        color: #5f6b7d;
      }

      button {
        padding: 0 14px;
        color: #f8fafc;
        background: #2563eb;
        cursor: pointer;
      }

      button.secondary,
      button.copy-btn {
        color: #d9e2ef;
        background: #171d28;
      }

      button.copy-btn {
        min-height: 32px;
        min-width: 72px;
        padding: 0 10px;
      }

      button.copy-btn.copied {
        border-color: rgba(34, 197, 94, 0.55);
        color: #bbf7d0;
        background: rgba(34, 197, 94, 0.2);
        cursor: default;
      }

      .status {
        min-height: 20px;
        margin: 10px 0 0;
        color: #8b95a7;
      }

      .status.error {
        color: #fb7185;
      }

      .table-panel {
        margin-top: 18px;
        overflow: hidden;
      }

      .table-header {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid #232a36;
      }

      .table-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
      }

      .table-actions {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .table-title-wrap {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .queue-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
      }

      .queue-tab {
        min-height: 34px;
        color: #d9e2ef;
        background: #171d28;
      }

      .queue-tab.active {
        color: #f8fafc;
        background: #2563eb;
      }

      .queue-tab.off {
        color: #fca5a5;
      }

      .queue-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }

      .queue-state {
        min-width: 72px;
        color: #86efac;
        font-weight: 700;
      }

      .queue-state.off {
        color: #fb7185;
      }

      .count {
        color: #8b95a7;
      }

      .table-wrap {
        overflow-x: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 920px;
      }

      th,
      td {
        padding: 12px 14px;
        border-bottom: 1px solid #1d2430;
        text-align: left;
        vertical-align: top;
      }

      th {
        color: #96a3b8;
        background: #0d1118;
        font-size: 12px;
        font-weight: 700;
      }

      td {
        color: #d8dee9;
      }

      tr:hover td {
        background: #151b25;
      }

      code,
      .empty-link {
        display: block;
        max-width: 360px;
        color: #aeb8c8;
        word-break: break-all;
        white-space: normal;
      }

      .empty-link {
        color: #5f6b7d;
      }

      .badge {
        display: inline-flex;
        width: fit-content;
        padding: 2px 8px;
        border-radius: 999px;
        color: #86efac;
        background: rgba(34, 197, 94, 0.14);
        font-size: 12px;
        font-weight: 700;
      }

      .badge.pending {
        color: #fbbf24;
        background: rgba(245, 158, 11, 0.14);
      }

      .badge.running,
      .badge.opening,
      .badge.watching,
      .badge.liking,
      .badge.reposting,
      .badge.composing,
      .badge.publishing {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
      }

      .badge.error {
        color: #fb7185;
        background: rgba(244, 63, 94, 0.14);
      }

      .badge.spam_reply {
        color: #fbbf24;
        background: rgba(245, 158, 11, 0.14);
      }

      .task-tag {
        display: inline-flex;
        width: fit-content;
        margin-bottom: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        color: #fecaca;
        background: rgba(239, 68, 68, 0.2);
        font-size: 12px;
        font-weight: 700;
      }

      .empty {
        padding: 18px 16px;
        color: #8b95a7;
      }

      @media (max-width: 760px) {
        header {
          display: grid;
          align-items: start;
        }

        form {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Wojak Task Console</h1>
          <p class="subtitle">输入链接后会加入所有队列，已启动的队列会按顺序执行。</p>
        </div>
        <button id="refreshBtn" class="secondary" type="button">发布八卦原贴</button>
      </header>

      <section class="input-panel">
        <form id="taskForm">
          <input id="targetUrl" name="targetUrl" type="url" placeholder="X 帖子链接，回车加入所有队列" required>
          <button type="submit">加入所有队列</button>
        </form>
        <p id="status" class="status"></p>
      </section>

      <section class="input-panel">
        <div id="queueTabs" class="queue-tabs"></div>
        <div class="queue-toolbar">
          <span id="queueState" class="queue-state">已启动</span>
          <button id="toggleQueueBtn" class="secondary" type="button">关闭</button>
          <button id="toggleTestModeBtn" class="secondary" type="button">开启测试</button>
          <button id="addQueueBtn" class="secondary" type="button">新增队列</button>
          <button id="renameQueueBtn" class="secondary" type="button">重命名</button>
          <button id="deleteQueueBtn" class="secondary" type="button">删除队列</button>
        </div>
      </section>

      <section class="table-panel">
        <div class="table-header">
          <div class="table-title-wrap">
            <h2 class="table-title">任务队列</h2>
            <button id="createOriginalBtn" class="secondary" type="button">发原创贴</button>
          </div>
          <div class="table-actions">
            <span id="taskCount" class="count">共 0 条</span>
            <button id="clearTasksBtn" class="secondary" type="button">清除日志</button>
          </div>
        </div>
        <div id="taskList" class="table-wrap"></div>
      </section>
    </main>

    <script>
      const form = document.getElementById("taskForm");
      const status = document.getElementById("status");
      const taskList = document.getElementById("taskList");
      const taskCount = document.getElementById("taskCount");
      const clearTasksBtn = document.getElementById("clearTasksBtn");
      const createOriginalBtn = document.getElementById("createOriginalBtn");
      const queueTabs = document.getElementById("queueTabs");
      const queueState = document.getElementById("queueState");
      const toggleQueueBtn = document.getElementById("toggleQueueBtn");
      const toggleTestModeBtn = document.getElementById("toggleTestModeBtn");
      const addQueueBtn = document.getElementById("addQueueBtn");
      const renameQueueBtn = document.getElementById("renameQueueBtn");
      const deleteQueueBtn = document.getElementById("deleteQueueBtn");
      let queues = [];
      let activeQueueId = localStorage.getItem("wojakActiveQueueId") || "default";

      function setStatus(text, isError = false) {
        status.textContent = text;
        status.className = isError ? "status error" : "status";
      }

      function badgeClass(state) {
        if (state === "pending") return "badge pending";
        if (state === "error") return "badge error";
        return "badge " + escapeHtml(state);
      }

      function escapeHtml(value) {
        return String(value || "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function formatTime(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString("zh-CN", { hour12: false });
      }

      async function copyText(text, button, taskId) {
        if (!text) return;
        await navigator.clipboard.writeText(text);
        const response = await fetch("/api/wojak/tasks/" + encodeURIComponent(taskId) + "/copied", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ copied: true })
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "复制状态保存失败");
        }
        button.textContent = "已复制";
        button.classList.add("copied");
        button.disabled = true;
      }

      function renderQueues() {
        if (!queues.some((queue) => queue.id === activeQueueId)) {
          activeQueueId = queues[0]?.id || "default";
        }
        queueTabs.innerHTML = queues.map((queue) => {
          const activeClass = queue.id === activeQueueId ? " active" : "";
          const offClass = queue.enabled === false ? " off" : "";
          const stateText = (queue.enabled === false ? "（关）" : "") + (queue.testMode ? "（测）" : "");
          return '<button class="queue-tab' + activeClass + offClass + '" type="button" data-queue-id="' + escapeHtml(queue.id) + '">' + escapeHtml(queue.name) + stateText + '</button>';
        }).join("");
        const activeQueue = queues.find((queue) => queue.id === activeQueueId);
        const enabled = activeQueue?.enabled !== false;
        queueState.textContent = (enabled ? "已启动" : "已关闭") + (activeQueue?.testMode ? "，测试中" : "");
        queueState.className = enabled ? "queue-state" : "queue-state off";
        toggleQueueBtn.textContent = enabled ? "关闭" : "启动";
        toggleTestModeBtn.textContent = activeQueue?.testMode ? "关闭测试" : "开启测试";
        deleteQueueBtn.disabled = queues.length <= 1;
      }

      async function refreshTasks() {
        const response = await fetch("/api/wojak/tasks?queueId=" + encodeURIComponent(activeQueueId));
        const payload = await response.json();
        queues = payload.queues || queues;
        activeQueueId = payload.queueId || activeQueueId;
        localStorage.setItem("wojakActiveQueueId", activeQueueId);
        document.getElementById("refreshBtn").textContent = "发布八卦原贴（n=" + Number(payload.gossipOriginalRound || 0) + "）";
        renderQueues();

        const tasks = payload.tasks || [];
        const resultsByTaskId = new Map((payload.results || []).map((result) => [result.taskId, result]));
        const rows = tasks.slice().reverse().map((task) => {
          const result = resultsByTaskId.get(task.id) || {};
          const commentedUrl = result.originalUrl || result.commentedUrl || result.replyUrl || "";
          const isSpamReply = task.state === "spam_reply" || result.state === "spam_reply";
          const isOriginal = task.type === "original";
          const isGossipOriginal = task.type === "gossip_original";
          const isCopied = Boolean(task.copiedAt);
          const completedAt = result.completedAt || task.completedAt || "";
          const copyButton = isGossipOriginal
            ? '<span class="empty-link">无需复制</span>'
            : commentedUrl
            ? '<button class="copy-btn' + (isCopied ? ' copied' : '') + '" type="button" data-copy="' + escapeHtml(commentedUrl) + '" data-copy-task-id="' + escapeHtml(task.id) + '"' + (isCopied ? ' disabled' : '') + '>' + (isCopied ? '已复制' : '复制') + '</button>'
            : (isSpamReply ? '<span class="empty-link">可能的垃圾贴</span>' : '<span class="empty-link">等待评论完成</span>');
          const deleteButton = '<button class="copy-btn" type="button" data-delete-task-id="' + escapeHtml(task.id) + '">删除记录</button>';
          return '<tr>' +
            '<td>' + (isOriginal ? '<span class="task-tag">原创贴</span>' : '') + (isGossipOriginal ? '<span class="task-tag">八卦原贴</span>' : '') + '<code>' + escapeHtml(task.targetUrl || task.originalText || "") + '</code></td>' +
            '<td>' + (commentedUrl ? '<code>' + escapeHtml(commentedUrl) + '</code>' : (isSpamReply ? '<span class="empty-link">可能的垃圾贴</span>' : '<span class="empty-link">暂无</span>')) + '</td>' +
            '<td><span class="' + badgeClass(task.state) + '">' + escapeHtml(task.state) + '</span>' + (task.error ? '<div class="status error">' + escapeHtml(task.error) + '</div>' : '') + '</td>' +
            '<td>' + escapeHtml(formatTime(task.createdAt)) + '</td>' +
            '<td>' + escapeHtml(formatTime(completedAt)) + '</td>' +
            '<td>' + copyButton + ' ' + deleteButton + '</td>' +
          '</tr>';
        }).join("");

        const activeQueue = queues.find((queue) => queue.id === activeQueueId);
        taskCount.textContent = (activeQueue?.name || activeQueueId) + "，共 " + tasks.length + " 条";
        taskList.innerHTML = tasks.length
          ? '<table><thead><tr><th>目标链接</th><th>已评论链接</th><th>状态</th><th>创建时间</th><th>评论时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">暂无任务</div>';
      }

      async function clearTasks() {
        if (!confirm("确定清除当前所有任务队列和执行日志吗？")) {
          return;
        }

        clearTasksBtn.disabled = true;
        setStatus("正在清除...");

        try {
          const response = await fetch("/api/wojak/tasks?queueId=" + encodeURIComponent(activeQueueId), { method: "DELETE" });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "清除失败");
          }

          setStatus("任务队列已清除。");
          await refreshTasks();
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          clearTasksBtn.disabled = false;
        }
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("正在提交...");

        const payload = {
          targetUrl: form.targetUrl.value.trim(),
          allQueues: true
        };

        try {
          const response = await fetch("/api/wojak/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "提交失败");
          }

          form.targetUrl.value = "";
          setStatus("已加入所有队列。");
          await refreshTasks();
        } catch (error) {
          setStatus(error.message, true);
        }
      });

      toggleQueueBtn.addEventListener("click", async () => {
        const current = queues.find((queue) => queue.id === activeQueueId);
        if (!current) return;
        const response = await fetch("/api/wojak/queues/" + encodeURIComponent(activeQueueId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: current.enabled === false })
        });
        const result = await response.json();
        if (!response.ok) {
          setStatus(result.error || "队列状态更新失败", true);
          return;
        }
        setStatus(result.queue.enabled ? "队列已启动。" : "队列已关闭。");
        await refreshTasks();
      });

      toggleTestModeBtn.addEventListener("click", async () => {
        const current = queues.find((queue) => queue.id === activeQueueId);
        if (!current) return;
        const response = await fetch("/api/wojak/queues/" + encodeURIComponent(activeQueueId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ testMode: !current.testMode })
        });
        const result = await response.json();
        if (!response.ok) {
          setStatus(result.error || "测试模式更新失败", true);
          return;
        }
        setStatus(result.queue.testMode ? "测试模式已开启，当前队列任务会跳过三连间隔。" : "测试模式已关闭。");
        await refreshTasks();
      });

      createOriginalBtn.addEventListener("click", async () => {
        const current = queues.find((queue) => queue.id === activeQueueId);
        if (current?.enabled === false) {
          setStatus("当前队列已关闭，不能创建原创贴。", true);
          return;
        }

        createOriginalBtn.disabled = true;
        setStatus("正在加入原创贴任务...");
        try {
          const response = await fetch("/api/wojak/original-tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ queueId: activeQueueId })
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "原创贴任务创建失败");
          }
          setStatus("原创贴任务已加入队列。");
          await refreshTasks();
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          createOriginalBtn.disabled = false;
        }
      });

      taskList.addEventListener("click", (event) => {
        const copyButton = event.target.closest("[data-copy]");
        if (copyButton) {
          copyText(copyButton.dataset.copy, copyButton, copyButton.dataset.copyTaskId).catch((error) => setStatus(error.message, true));
          return;
        }

        const deleteButton = event.target.closest("[data-delete-task-id]");
        if (!deleteButton || !confirm("确定删除这条任务记录吗？")) {
          return;
        }

        fetch("/api/wojak/tasks/" + encodeURIComponent(deleteButton.dataset.deleteTaskId), { method: "DELETE" })
          .then(async (response) => {
            const result = await response.json();
            if (!response.ok) {
              throw new Error(result.error || "删除失败");
            }
            setStatus("任务记录已删除。");
            await refreshTasks();
          })
          .catch((error) => setStatus(error.message, true));
      });

      queueTabs.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-queue-id]");
        if (!button) return;
        activeQueueId = button.dataset.queueId;
        localStorage.setItem("wojakActiveQueueId", activeQueueId);
        setStatus("");
        await refreshTasks();
      });

      addQueueBtn.addEventListener("click", async () => {
        const name = prompt("请输入队列名称");
        if (!name) return;
        const response = await fetch("/api/wojak/queues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        const result = await response.json();
        if (!response.ok) {
          setStatus(result.error || "新增队列失败", true);
          return;
        }
        activeQueueId = result.queue.id;
        localStorage.setItem("wojakActiveQueueId", activeQueueId);
        setStatus("队列已新增。");
        await refreshTasks();
      });

      renameQueueBtn.addEventListener("click", async () => {
        const current = queues.find((queue) => queue.id === activeQueueId);
        const name = prompt("请输入新的队列名称", current?.name || "");
        if (!name) return;
        const response = await fetch("/api/wojak/queues/" + encodeURIComponent(activeQueueId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        const result = await response.json();
        if (!response.ok) {
          setStatus(result.error || "重命名失败", true);
          return;
        }
        setStatus("队列已重命名。");
        await refreshTasks();
      });

      deleteQueueBtn.addEventListener("click", async () => {
        const current = queues.find((queue) => queue.id === activeQueueId);
        if (!current || !confirm("确定删除队列“" + current.name + "”及其任务日志吗？")) {
          return;
        }
        const response = await fetch("/api/wojak/queues/" + encodeURIComponent(activeQueueId), { method: "DELETE" });
        const result = await response.json();
        if (!response.ok) {
          setStatus(result.error || "删除队列失败", true);
          return;
        }
        activeQueueId = result.queueId || "default";
        localStorage.setItem("wojakActiveQueueId", activeQueueId);
        setStatus("队列已删除。");
        await refreshTasks();
      });

      document.getElementById("refreshBtn").addEventListener("click", async () => {
        const button = document.getElementById("refreshBtn");
        button.disabled = true;
        setStatus("正在给所有队列加入八卦原贴任务...");
        try {
          const response = await fetch("/api/wojak/gossip-original-tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" }
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "八卦原贴任务创建失败");
          }
          setStatus("已给所有队列加入 " + (result.tasks?.length || 0) + " 条八卦原贴任务。");
          await refreshTasks();
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
      clearTasksBtn.addEventListener("click", clearTasks);
      refreshTasks();
      window.setInterval(refreshTasks, 5000);
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderHomePage());
      return;
    }

    const imageMatch = decodeURIComponent(url.pathname).match(/^\/image\/([^/]+)$/);
    if (request.method === "GET" && imageMatch) {
      const filePath = path.resolve(IMAGE_DIR, imageMatch[1]);
      if (!filePath.startsWith(IMAGE_DIR) || !fs.existsSync(filePath)) {
        sendJson(response, 404, { error: "Image not found" });
        return;
      }
      sendFile(response, filePath);
      return;
    }

    const gossipImageMatch = decodeURIComponent(url.pathname).match(/^\/gpt-image2\/image\/([^/]+)$/);
    if (request.method === "GET" && gossipImageMatch) {
      const filePath = path.resolve(GOSSIP_IMAGE_DIR, gossipImageMatch[1]);
      if (!filePath.startsWith(GOSSIP_IMAGE_DIR) || !fs.existsSync(filePath)) {
        sendJson(response, 404, { error: "Gossip image not found" });
        return;
      }
      sendFile(response, filePath);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wojak/queues") {
      sendJson(response, 200, { queues, defaultQueueId: DEFAULT_QUEUE_ID });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wojak/queues") {
      const payload = await readJson(request);
      const queue = createQueue(payload);
      queues.push(queue);
      sendJson(response, 201, { queue, queues });
      return;
    }

    const queueMatch = url.pathname.match(/^\/api\/wojak\/queues\/([^/]+)$/);
    if (request.method === "PATCH" && queueMatch) {
      const queue = queues.find((item) => item.id === queueMatch[1]);
      if (!queue) {
        sendJson(response, 404, { error: "Queue not found" });
        return;
      }
      const payload = await readJson(request);
      const name = String(payload.name || "").trim();
      if (name) {
        queue.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(payload, "enabled")) {
        queue.enabled = Boolean(payload.enabled);
      }
      if (Object.prototype.hasOwnProperty.call(payload, "testMode")) {
        queue.testMode = Boolean(payload.testMode);
      }
      sendJson(response, 200, { queue, queues });
      return;
    }

    if (request.method === "DELETE" && queueMatch) {
      if (queues.length <= 1) {
        sendJson(response, 400, { error: "至少保留一个队列" });
        return;
      }
      const queueIndex = queues.findIndex((item) => item.id === queueMatch[1]);
      if (queueIndex < 0) {
        sendJson(response, 404, { error: "Queue not found" });
        return;
      }
      const queueId = queues[queueIndex].id;
      queues.splice(queueIndex, 1);
      const removedTaskIds = new Set(tasks.filter((task) => task.queueId === queueId).map((task) => task.id));
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        if (tasks[index].queueId === queueId) {
          tasks.splice(index, 1);
        }
      }
      for (let index = results.length - 1; index >= 0; index -= 1) {
        if (removedTaskIds.has(results[index].taskId)) {
          results.splice(index, 1);
        }
      }
      sendJson(response, 200, { ok: true, queueId: queues[0].id, queues });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wojak/tasks") {
      const payload = await readJson(request);
      const targetUrl = String(payload.targetUrl || payload.url || "").trim();
      if (!targetUrl) {
        sendJson(response, 400, { error: "targetUrl is required" });
        return;
      }

      if (payload.allQueues) {
        const createdTasks = queues
          .filter((queue) => queue.enabled !== false)
          .map((queue) => createTask({ ...payload, queueId: queue.id }));
        tasks.push(...createdTasks);
        sendJson(response, 201, { tasks: createdTasks });
        return;
      }

      const task = createTask(payload);
      tasks.push(task);
      sendJson(response, 201, { task });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wojak/original-tasks") {
      const payload = await readJson(request);
      const queueId = normalizeQueueId(payload.queueId);
      const queue = queues.find((item) => item.id === queueId);
      if (queue?.enabled === false) {
        sendJson(response, 400, { error: "当前队列已关闭" });
        return;
      }

      const image = loadRandomImageUrl(request);
      const task = createTask({
        type: "original",
        queueId,
        targetUrl: "https://x.com/home",
        originalText: loadRandomOriginal(),
        imageAssetPath: image.imageAssetPath,
        imageFileName: image.imageFileName
      });
      tasks.push(task);
      sendJson(response, 201, { task });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wojak/gossip-original-tasks") {
      await readJson(request);
      const round = gossipOriginalRound;
      const queueCount = queues.length;
      const createdTasks = queues.map((queue, index) => {
        const gossip = loadGossipOriginal(request, round * queueCount + index);
        return createTask({
          type: "gossip_original",
          queueId: queue.id,
          targetUrl: "https://x.com/home",
          originalText: gossip.originalText,
          imageAssetPath: gossip.imageAssetPath,
          imageFileName: gossip.imageFileName
        });
      });
      gossipOriginalRound += 1;
      tasks.push(...createdTasks);
      sendJson(response, 201, { tasks: createdTasks, round, nextRound: gossipOriginalRound });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wojak/tasks/next") {
      const queueId = normalizeQueueId(url.searchParams.get("queueId"));
      const queue = queues.find((item) => item.id === queueId);
      const pendingTask = tasks.find((item) => item.queueId === queueId && item.state === "pending");
      if (queue?.enabled === false && pendingTask?.type !== "gossip_original") {
        sendJson(response, 200, { task: null, queueDisabled: true });
        return;
      }

      releaseStaleRunningTasks(queueId);
      const runningTask = tasks.find((item) => item.queueId === queueId && isTaskActive(item));
      if (runningTask) {
        sendJson(response, 200, { task: null, runningTaskId: runningTask.id });
        return;
      }

      const task = pendingTask;

      if (!task) {
        sendJson(response, 200, { task: null });
        return;
      }

      if (task.type !== "original" && task.type !== "gossip_original" && !task.commentText) {
        task.commentText = loadRandomComment();
      }
      if (task.type === "original" && !task.originalText) {
        task.originalText = loadRandomOriginal();
      }
      if (task.type === "gossip_original" && !task.originalText) {
        const gossip = loadGossipOriginal(request);
        task.originalText = gossip.originalText;
        task.imageAssetPath = gossip.imageAssetPath;
        task.imageFileName = gossip.imageFileName;
      }
      const startedAt = new Date().toISOString();
      task.state = "running";
      task.startedAt = startedAt;
      task.heartbeatAt = startedAt;
      task.updatedAt = startedAt;
      task.error = "";
      sendJson(response, 200, { task });
      return;
    }

    const progressMatch = url.pathname.match(/^\/api\/wojak\/tasks\/([^/]+)\/progress$/);
    if (request.method === "POST" && progressMatch) {
      const payload = await readJson(request);
      const task = tasks.find((item) => item.id === progressMatch[1]);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      const heartbeatAt = new Date().toISOString();
      task.state = payload.state || task.state || "running";
      task.error = payload.error || "";
      task.heartbeatAt = heartbeatAt;
      task.updatedAt = heartbeatAt;
      sendJson(response, 200, { ok: true, task });
      return;
    }

    const resultMatch = url.pathname.match(/^\/api\/wojak\/tasks\/([^/]+)\/result$/);
    if (request.method === "POST" && resultMatch) {
      const payload = await readJson(request);
      const task = tasks.find((item) => item.id === resultMatch[1]);
      const completedAt = new Date().toISOString();
      if (task) {
        task.state = payload.state || "done";
        task.error = payload.error || "";
        task.completedAt = completedAt;
        task.heartbeatAt = completedAt;
        task.updatedAt = completedAt;
      }

      results.push({
        taskId: resultMatch[1],
        ...payload,
        receivedAt: completedAt
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    const copiedMatch = url.pathname.match(/^\/api\/wojak\/tasks\/([^/]+)\/copied$/);
    if (request.method === "PATCH" && copiedMatch) {
      const payload = await readJson(request);
      const task = tasks.find((item) => item.id === copiedMatch[1]);
      if (!task) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      task.copiedAt = payload.copied === false ? "" : new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      sendJson(response, 200, { ok: true, task });
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/wojak\/tasks\/([^/]+)$/);
    if (request.method === "DELETE" && taskMatch) {
      const taskId = taskMatch[1];
      const taskIndex = tasks.findIndex((item) => item.id === taskId);
      if (taskIndex < 0) {
        sendJson(response, 404, { error: "Task not found" });
        return;
      }

      // 只删除前台展示记录，不干预已经被扩展拿走的三连执行。
      tasks.splice(taskIndex, 1);
      for (let index = results.length - 1; index >= 0; index -= 1) {
        if (results[index].taskId === taskId) {
          results.splice(index, 1);
        }
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wojak/tasks") {
      const queueId = normalizeQueueId(url.searchParams.get("queueId"));
      releaseStaleRunningTasks(queueId);
      const queueTasks = tasks.filter((task) => task.queueId === queueId);
      const queueTaskIds = new Set(queueTasks.map((task) => task.id));
      const queueResults = results.filter((result) => queueTaskIds.has(result.taskId));
      sendJson(response, 200, {
        queueId,
        queueName: queueLabel(queueId),
        gossipOriginalRound,
        queues,
        tasks: queueTasks,
        results: queueResults
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/wojak/tasks") {
      const queueId = normalizeQueueId(url.searchParams.get("queueId"));
      // 清除当前窗口队列和对应执行结果日志。
      const removedTaskIds = new Set(tasks.filter((task) => task.queueId === queueId).map((task) => task.id));
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        if (tasks[index].queueId === queueId) {
          tasks.splice(index, 1);
        }
      }
      for (let index = results.length - 1; index >= 0; index -= 1) {
        if (removedTaskIds.has(results[index].taskId)) {
          results.splice(index, 1);
        }
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Wojak local task server listening on http://127.0.0.1:${PORT}`);
});
