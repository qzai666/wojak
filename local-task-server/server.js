const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);

const tasks = [];
const results = [];
const COMMENTS_PATH = path.resolve(__dirname, "../comments.json");

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
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

function createTask(payload) {
  return {
    id: crypto.randomUUID(),
    targetUrl: String(payload.targetUrl || payload.url || "").trim(),
    commentText: String(payload.commentText || "").trim(),
    imageAssetPath: String(payload.imageAssetPath || "").trim(),
    imageFileName: String(payload.imageFileName || "").trim(),
    state: "pending",
    createdAt: new Date().toISOString()
  };
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function loadRandomComment() {
  const comments = JSON.parse(fs.readFileSync(COMMENTS_PATH, "utf8"));
  const item = pick(comments);
  return String(item?.content || "").trim();
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
      button {
        min-height: 40px;
        border: 1px solid #2c3545;
        border-radius: 7px;
        font: inherit;
      }

      input {
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
          <p class="subtitle">输入链接加入队列，扩展会按顺序执行一键三连。</p>
        </div>
        <button id="refreshBtn" class="secondary" type="button">刷新任务</button>
      </header>

      <section class="input-panel">
        <form id="taskForm">
          <input id="targetUrl" name="targetUrl" type="url" placeholder="X 帖子链接，回车加入队列" required>
          <button type="submit">加入队列</button>
        </form>
        <p id="status" class="status"></p>
      </section>

      <section class="table-panel">
        <div class="table-header">
          <h2 class="table-title">任务队列</h2>
          <span id="taskCount" class="count">共 0 条</span>
        </div>
        <div id="taskList" class="table-wrap"></div>
      </section>
    </main>

    <script>
      const form = document.getElementById("taskForm");
      const status = document.getElementById("status");
      const taskList = document.getElementById("taskList");
      const taskCount = document.getElementById("taskCount");

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

      async function copyText(text, button) {
        if (!text) return;
        await navigator.clipboard.writeText(text);
        const oldText = button.textContent;
        button.textContent = "已复制";
        button.disabled = true;
        setTimeout(() => {
          button.textContent = oldText;
          button.disabled = false;
        }, 1400);
      }

      async function refreshTasks() {
        const response = await fetch("/api/wojak/tasks");
        const payload = await response.json();
        const tasks = payload.tasks || [];
        const resultsByTaskId = new Map((payload.results || []).map((result) => [result.taskId, result]));
        const rows = tasks.slice().reverse().map((task) => {
          const result = resultsByTaskId.get(task.id) || {};
          const commentedUrl = result.commentedUrl || result.replyUrl || "";
          const completedAt = result.completedAt || task.completedAt || "";
          const copyButton = commentedUrl
            ? '<button class="copy-btn" type="button" data-copy="' + escapeHtml(commentedUrl) + '">复制</button>'
            : '<span class="empty-link">等待评论完成</span>';
          return '<tr>' +
            '<td><code>' + escapeHtml(task.targetUrl) + '</code></td>' +
            '<td>' + (commentedUrl ? '<code>' + escapeHtml(commentedUrl) + '</code>' : '<span class="empty-link">暂无</span>') + '</td>' +
            '<td><span class="' + badgeClass(task.state) + '">' + escapeHtml(task.state) + '</span>' + (task.error ? '<div class="status error">' + escapeHtml(task.error) + '</div>' : '') + '</td>' +
            '<td>' + escapeHtml(formatTime(completedAt)) + '</td>' +
            '<td>' + copyButton + '</td>' +
          '</tr>';
        }).join("");

        taskCount.textContent = "共 " + tasks.length + " 条";
        taskList.innerHTML = tasks.length
          ? '<table><thead><tr><th>目标链接</th><th>已评论链接</th><th>状态</th><th>评论时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">暂无任务</div>';
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("正在提交...");

        const payload = {
          targetUrl: form.targetUrl.value.trim()
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
          setStatus("已加入队列。");
          await refreshTasks();
        } catch (error) {
          setStatus(error.message, true);
        }
      });

      taskList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-copy]");
        if (!button) return;
        copyText(button.dataset.copy, button).catch((error) => setStatus(error.message, true));
      });

      document.getElementById("refreshBtn").addEventListener("click", refreshTasks);
      refreshTasks();
      window.setInterval(refreshTasks, 5000);
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderHomePage());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wojak/tasks") {
      const payload = await readJson(request);
      const task = createTask(payload);
      if (!task.targetUrl) {
        sendJson(response, 400, { error: "targetUrl is required" });
        return;
      }

      tasks.push(task);
      sendJson(response, 201, { task });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wojak/tasks/next") {
      const task = tasks.find((item) => item.state === "pending");

      if (!task) {
        sendJson(response, 200, { task: null });
        return;
      }

      if (!task.commentText) {
        task.commentText = loadRandomComment();
      }
      task.state = "running";
      task.startedAt = new Date().toISOString();
      sendJson(response, 200, { task });
      return;
    }

    const resultMatch = url.pathname.match(/^\/api\/wojak\/tasks\/([^/]+)\/result$/);
    if (request.method === "POST" && resultMatch) {
      const payload = await readJson(request);
      const task = tasks.find((item) => item.id === resultMatch[1]);
      if (task) {
        task.state = payload.state || "done";
        task.error = payload.error || "";
        task.completedAt = new Date().toISOString();
      }

      results.push({
        taskId: resultMatch[1],
        ...payload,
        receivedAt: new Date().toISOString()
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wojak/tasks") {
      sendJson(response, 200, { tasks, results });
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
