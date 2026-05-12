const AUTO_LIKE_INTERVAL_MS = 3000;
const TARGET_LOAD_TIMEOUT_MS = 5000;
const MAX_TARGET_REFRESH_COUNT = 3;
const SHORT_WAIT_MS = 500;
const UPLOAD_WAIT_MS = 15000;

let autoLikeTimer = null;
let autoLikeTask = null;
let lastReloadAt = 0;
let scriptStartedAt = Date.now();
let isTicking = false;

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        resolve({ ok: false, error: "Extension context invalidated" });
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        resolve(response || { ok: false, error: chrome.runtime.lastError?.message });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

async function sendRequiredMessage(message) {
  const response = await sendMessage(message);
  if (response.ok) {
    return response;
  }

  if (/Extension context invalidated/i.test(response.error || "")) {
    // 扩展重载后旧 content script 不能继续通信，停止当前页面上的轮询。
    window.clearInterval(autoLikeTimer);
    autoLikeTimer = null;
    autoLikeTask = null;
  }

  return response;
}

function statusIdFromUrl(url) {
  const match = String(url).match(/\/status\/(\d+)/);
  return match ? match[1] : "";
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

function isTargetUrl(task) {
  return statusIdFromUrl(location.href) === task.statusId;
}

function isPageReady() {
  return document.readyState === "complete" || document.readyState === "interactive";
}

function getTargetArticle(task) {
  const articles = Array.from(document.querySelectorAll("article"));
  return articles.find((article) => {
    const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'));
    return statusLinks.some((link) => statusIdFromUrl(link.href) === task.statusId);
  }) || articles[0] || null;
}

function findLikeButton(article) {
  if (!article) {
    return null;
  }

  const likedButton = article.querySelector('[data-testid="unlike"], button[aria-label*="Liked"]');
  if (likedButton) {
    return { button: likedButton, liked: true };
  }

  const directLike = article.querySelector('[data-testid="like"]');
  if (directLike) {
    return { button: directLike, liked: false };
  }

  const buttons = Array.from(article.querySelectorAll("button"));
  const likeButton = buttons.find((button) => {
    const label = button.getAttribute("aria-label") || "";
    return /\bLike\b/i.test(label) && !/\bLiked\b/i.test(label);
  });

  return likeButton ? { button: likeButton, liked: false } : null;
}

function getLikeableHomeArticles() {
  return Array.from(document.querySelectorAll("article")).filter((article) => {
    const like = findLikeButton(article);
    return like && !like.liked && isVisible(article) && isVisible(like.button);
  });
}

function findRepostButton(article) {
  if (!article) {
    return null;
  }

  const repostedButton = article.querySelector('[data-testid="unretweet"], button[aria-label*="Reposted"]');
  if (repostedButton) {
    return { button: repostedButton, reposted: true };
  }

  const directRepost = article.querySelector('[data-testid="retweet"]');
  if (directRepost) {
    return { button: directRepost, reposted: false };
  }

  const buttons = Array.from(article.querySelectorAll("button"));
  const repostButton = buttons.find((button) => {
    const label = button.getAttribute("aria-label") || "";
    return /\bRepost\b/i.test(label) && !/\bReposted\b/i.test(label);
  });

  return repostButton ? { button: repostButton, reposted: false } : null;
}

function isVisible(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function visibleArticles() {
  return Array.from(document.querySelectorAll("article")).filter((article) => {
    const rect = article.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < window.innerHeight - 60 && isVisible(article);
  });
}

async function humanScrollHome() {
  const steps = randomInt(3, 6);
  for (let step = 0; step < steps; step += 1) {
    const direction = step > 1 && Math.random() < 0.22 ? -1 : 1;
    const distance = randomInt(220, Math.max(360, Math.floor(window.innerHeight * 0.85))) * direction;
    window.scrollBy({
      top: distance,
      behavior: "smooth"
    });
    await delay(randomInt(900, 2200));

    if (Math.random() < 0.28) {
      window.scrollBy({
        top: randomInt(-160, 180),
        behavior: "smooth"
      });
      await delay(randomInt(600, 1300));
    }
  }
}

async function waitForCondition(check, timeoutMs, intervalMs = SHORT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) {
      return result;
    }
    await delay(intervalMs);
  }
  return check();
}

function isPostOpen(task) {
  if (!isTargetUrl(task) || !isPageReady()) {
    return false;
  }

  const article = getTargetArticle(task);
  return Boolean(article && findLikeButton(article));
}

async function reportState(patch) {
  await sendRequiredMessage({
    type: "UPDATE_AUTO_LIKE_TASK",
    patch
  });
}

async function stopTask(state) {
  window.clearInterval(autoLikeTimer);
  autoLikeTimer = null;
  autoLikeTask = null;
  await reportState(state);
}

async function fetchImageFile(task) {
  if (!task.imageAssetPath) {
    return null;
  }

  const response = await fetch(chrome.runtime.getURL(task.imageAssetPath));
  if (!response.ok) {
    throw new Error(`Image load failed: ${task.imageAssetPath}`);
  }

  const blob = await response.blob();
  const fileName = task.imageFileName || task.imageAssetPath.split("/").pop() || "reply-image.jpg";
  return new File([blob], fileName, { type: blob.type || "image/jpeg" });
}

function findReplyTextbox() {
  const selectors = [
    '[data-testid="tweetTextarea_0"][contenteditable="true"]',
    '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]'
  ];
  const textboxes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  return textboxes.find((textbox) => isVisible(textbox) && textbox.getAttribute("aria-label") !== "Search query") || null;
}

function fillTextbox(textbox, text) {
  textbox.scrollIntoView({ block: "center" });
  textbox.focus();

  const existingText = (textbox.textContent || "").trim();
  if (existingText === text.trim()) {
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(textbox);
  selection.removeAllRanges();
  selection.addRange(range);

  textbox.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "deleteContentBackward"
  }));
  document.execCommand("delete", false, null);

  textbox.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: text
  }));
  document.execCommand("insertText", false, text);
  textbox.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: text
  }));
}

function pasteTextIntoTextbox(textbox, text) {
  try {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    });
    textbox.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

function scopedComposerTextIncludes(textbox, text) {
  const expected = normalizeText(text);
  const root = findComposerElement(textbox);
  const textboxText = normalizeText(textbox.textContent || "");
  const inlineReplyText = normalizeText(root.querySelector('[data-testid="inline_reply_offscreen"]')?.textContent || "");
  const composerText = normalizeText(root.textContent || "");
  const draftBlockText = normalizeText(Array.from(root.querySelectorAll("div.public-DraftStyleDefault-block"))
    .map((block) => block.textContent || "")
    .join(" "));
  return textboxText.includes(expected) || inlineReplyText.includes(expected) || composerText.includes(expected) || draftBlockText.includes(expected);
}

async function ensureReplyText(textbox, text) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fillTextbox(textbox, "");
    pasteTextIntoTextbox(textbox, text);
    let hasText = await waitForCondition(() => scopedComposerTextIncludes(textbox, text), 1500, 200);
    if (!hasText) {
      fillTextbox(textbox, text);
      hasText = await waitForCondition(() => scopedComposerTextIncludes(textbox, text), 1500, 200);
    }
    if (hasText) {
      return;
    }
  }

  throw new Error("Reply text did not fill");
}

function findComposerRoot(textbox) {
  let node = textbox;
  let fileInputRoot = null;
  let replyButtonRoot = null;
  for (let depth = 0; node && depth < 15; depth += 1) {
    const replyButton = node.querySelector?.('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
    const fileInput = node.querySelector?.('input[type="file"]');
    if (replyButton) {
      replyButtonRoot = node;
    }
    if (fileInput && !fileInputRoot) {
      fileInputRoot = node;
    }
    node = node.parentElement;
  }
  return replyButtonRoot || fileInputRoot || document;
}

function findComposerElement(textbox) {
  return textbox.closest("article") || findComposerRoot(textbox);
}

function findFileInput(root) {
  const inputs = Array.from(root.querySelectorAll('input[type="file"]'));
  return inputs.find((input) => /image|\*/i.test(input.accept || "")) || inputs[0] || null;
}

function hasInlineReplyPreview(root) {
  const selector = [
    '[data-testid="inline_reply_offscreen"] div img[src^="blob:"]',
    '[data-testid="inline_reply_offscreen"] div img[src^="bold:"]'
  ].join(", ");

  return Boolean(root.querySelector(selector) || document.querySelector(selector));
}

function hasImageAttachment(root) {
  const mediaSelectors = [
    '[data-testid="inline_reply_offscreen"] div img[src^="blob:"]',
    '[data-testid="inline_reply_offscreen"] div img[src^="bold:"]',
    '[data-testid="removeMedia"]',
    '[data-testid="attachments"]',
    '[data-testid="tweetPhoto"]',
    '[aria-label*="Remove media"]',
    '[aria-label*="移除媒体"]',
    '[aria-label*="Remove image"]',
    '[aria-label*="移除图片"]',
    '[aria-label*="Image"]',
    '[aria-label*="图片"]',
    'button[aria-label*="Edit"]',
    'button[aria-label*="编辑"]',
    'img',
    'video',
    'img[src^="blob:"]',
    'video[src^="blob:"]',
    'img[src*="twimg.com"]'
  ];

  return mediaSelectors.some((selector) => Array.from(root.querySelectorAll(selector)).some((node) => {
    const label = node.getAttribute("aria-label") || node.textContent || "";
    const isMediaNode = node.matches('img, video, [data-testid="tweetPhoto"], [data-testid="attachments"], [data-testid="removeMedia"]');
    const isEditButton = /edit|编辑/i.test(label);
    const rect = node.getBoundingClientRect();
    const largeEnoughPreview = rect.width >= 64 && rect.height >= 64;
    return isVisible(node) && (isEditButton || (isMediaNode && largeEnoughPreview));
  }));
}

function mediaMarkerCount(root) {
  const selectors = [
    '[data-testid="removeMedia"]',
    '[data-testid="attachments"]',
    '[data-testid="tweetPhoto"]',
    'button[aria-label*="Edit"]',
    'button[aria-label*="编辑"]',
    'img',
    'video',
    '[aria-label*="Image"]',
    '[aria-label*="图片"]'
  ];

  const nodes = new Set();
  selectors.forEach((selector) => {
    root.querySelectorAll(selector).forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (isVisible(node) && (rect.width >= 64 || rect.height >= 64)) {
        nodes.add(node);
      }
    });
  });
  return nodes.size;
}

function hasActiveUpload(root) {
  return Boolean(root.querySelector('[aria-label*="Uploading"], [aria-label*="uploading"], [aria-label*="上传"]'));
}

function findClosestFileInput(root) {
  const scopedInput = findFileInput(root);
  if (scopedInput) {
    return scopedInput;
  }

  const visibleMediaButtons = Array.from(document.querySelectorAll('[data-testid="fileInput"], input[type="file"]'));
  return visibleMediaButtons.find((element) => element.tagName === "INPUT") || document.querySelector('input[type="file"]');
}

function pasteImageIntoTextbox(textbox, file) {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    });
    textbox.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

async function attachImage(root, textbox, task) {
  const file = await fetchImageFile(task);
  if (!file) {
    return false;
  }

  textbox.focus();
  const input = findClosestFileInput(root);
  if (!input) {
    return pasteImageIntoTextbox(textbox, file);
  }

  const transfer = new DataTransfer();
  transfer.items.add(file);
  const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
  if (filesSetter) {
    filesSetter.call(input, transfer.files);
  } else {
    input.files = transfer.files;
  }
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return true;
}

async function waitForImageAttachment(root, beforeMediaCount) {
  const deadline = Date.now() + UPLOAD_WAIT_MS;
  const relaxedDeadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    if (hasInlineReplyPreview(root)) {
      return;
    }

    const hasNewMedia = mediaMarkerCount(root) > beforeMediaCount;
    const hasComposerMedia = hasImageAttachment(root);
    if ((hasComposerMedia || hasNewMedia) && !hasActiveUpload(root)) {
      return;
    }

    const button = findReplyButton(root);
    const buttonReady = button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    if (Date.now() >= relaxedDeadline && buttonReady && !hasActiveUpload(root)) {
      return;
    }

    await delay(SHORT_WAIT_MS);
  }

  throw new Error("Image attachment preview did not appear");
}

function findReplyButton(root) {
  const direct = root.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
  if (direct) {
    return direct;
  }

  const buttons = Array.from(root.querySelectorAll("button"));
  const scopedButton = buttons.find((button) => {
    const label = button.getAttribute("aria-label") || button.textContent || "";
    return /^(Reply|回复|Post|发布|发送)$/i.test(normalizeText(label));
  });
  if (scopedButton) {
    return scopedButton;
  }
  return null;
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function getArticleStatusUrls(article) {
  return Array.from(article.querySelectorAll('a[href*="/status/"]'))
    .map((link) => normalizeXUrl(link.href))
    .filter((url) => statusIdFromUrl(url));
}

function getVisibleStatusIds() {
  return new Set(Array.from(document.querySelectorAll('a[href*="/status/"]'))
    .map((link) => statusIdFromUrl(link.href))
    .filter(Boolean));
}

function findReplyUrl(commentText, beforeStatusIds, targetStatusId) {
  const targetText = normalizeText(commentText);
  const articles = Array.from(document.querySelectorAll("article"));

  for (const article of articles) {
    const articleText = normalizeText(article.textContent || "");
    if (!articleText.includes(targetText)) {
      continue;
    }

    const urls = getArticleStatusUrls(article);
    const replyUrl = urls.find((url) => {
      const statusId = statusIdFromUrl(url);
      return statusId && statusId !== targetStatusId && !beforeStatusIds.has(statusId);
    }) || urls.find((url) => statusIdFromUrl(url) !== targetStatusId);

    if (replyUrl) {
      return replyUrl;
    }
  }

  return "";
}

function hasExistingReply(commentText) {
  const target = normalizeText(commentText);
  if (!target) {
    return false;
  }

  return Array.from(document.querySelectorAll("article")).some((article) => {
    const text = normalizeText(article.textContent || "");
    return text.includes(target);
  });
}

async function waitForEnabledButton(root) {
  const deadline = Date.now() + UPLOAD_WAIT_MS + 10000;
  let button = findReplyButton(root);

  while ((!button || button.disabled || button.getAttribute("aria-disabled") === "true") && Date.now() < deadline) {
    await delay(SHORT_WAIT_MS);
    button = findReplyButton(root);
  }

  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
    throw new Error("Reply button did not become enabled");
  }

  return button;
}

async function ensureLiked(article) {
  const like = findLikeButton(article);
  if (!like) {
    throw new Error("Like button not found");
  }

  if (like.liked) {
    await reportState({ state: "already_liked" });
    return;
  }

  await reportState({ state: "liking" });
  like.button.click();

  const liked = await waitForCondition(() => {
    const nextLike = findLikeButton(article);
    return nextLike?.liked;
  }, 5000, 250);

  if (!liked) {
    throw new Error("Like did not complete");
  }

  await reportState({ state: "liked" });
}

async function browseHome(options = {}) {
  const shouldLike = options.shouldLike !== false;
  if (!location.pathname.startsWith("/home")) {
    location.assign("https://x.com/home");
    await waitForCondition(() => location.pathname.startsWith("/home") && isPageReady(), 8000, 500);
  }

  await waitForCondition(() => isPageReady() && document.querySelector("article"), 8000, 500);
  // 无任务时先浏览一段首页；是否点赞由后台的首页点赞间隔决定。
  await delay(randomInt(800, 1800));
  await humanScrollHome();
  if (!shouldLike) {
    return { browsed: true, liked: false, reason: "scroll_only" };
  }

  let articles = getLikeableHomeArticles().filter((article) => visibleArticles().includes(article));

  if (!articles.length) {
    window.scrollBy({
      top: randomInt(420, Math.max(520, Math.floor(window.innerHeight * 1.1))),
      behavior: "smooth"
    });
    await delay(randomInt(1200, 2200));
    articles = getLikeableHomeArticles().filter((article) => visibleArticles().includes(article));
  }

  const article = articles[Math.floor(Math.random() * articles.length)];
  const like = findLikeButton(article);
  if (!article || !like || like.liked) {
    return { liked: false, reason: "no_likeable_article" };
  }

  like.button.click();
  const liked = await waitForCondition(() => findLikeButton(article)?.liked, 5000, 250);
  return { browsed: true, liked: Boolean(liked), reason: liked ? "liked" : "like_timeout" };
}

function findRepostConfirmButton() {
  const direct = document.querySelector('[data-testid="retweetConfirm"]');
  if (direct && isVisible(direct)) {
    return direct;
  }

  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button')).filter(isVisible);
  return menuItems.find((item) => {
    const text = normalizeText(item.textContent || item.getAttribute("aria-label") || "");
    return /^(Repost|转发|转帖)$/.test(text);
  }) || null;
}

async function ensureReposted(article) {
  const repost = findRepostButton(article);
  if (!repost) {
    throw new Error("Repost button not found");
  }

  if (repost.reposted) {
    await reportState({ state: "already_reposted" });
    return;
  }

  await reportState({ state: "reposting" });
  repost.button.click();

  const confirm = await waitForCondition(findRepostConfirmButton, 5000, 250);
  if (!confirm) {
    throw new Error("Repost confirm button not found");
  }

  confirm.click();

  const reposted = await waitForCondition(() => {
    const nextRepost = findRepostButton(article);
    return nextRepost?.reposted;
  }, 5000, 250);

  if (!reposted) {
    throw new Error("Repost did not complete");
  }

  await reportState({ state: "reposted" });
}

async function publishReply(task) {
  if (!task.commentText) {
    throw new Error("Comment text is empty");
  }

  if (hasExistingReply(task.commentText)) {
    await stopTask({ state: "already_replied", completedAt: Date.now() });
    return;
  }

  await reportState({ state: "composing" });
  const textbox = findReplyTextbox();
  if (!textbox) {
    throw new Error("Reply textbox not found");
  }

  await ensureReplyText(textbox, task.commentText);
  const root = findComposerElement(textbox);

  if (task.imageAssetPath) {
    await reportState({ state: "uploading_image" });
    const beforeMediaCount = mediaMarkerCount(root);
    const uploadStarted = await attachImage(root, textbox, task);
    if (!uploadStarted) {
      throw new Error("Image upload input not found and paste fallback failed");
    }
    await reportState({ state: "waiting_image" });
    await waitForImageAttachment(root, beforeMediaCount);
  }

  const beforeStatusIds = getVisibleStatusIds();
  const finalTextbox = findReplyTextbox() || textbox;
  await ensureReplyText(finalTextbox, task.commentText);

  await reportState({ state: "publishing" });
  const finalRoot = findComposerElement(finalTextbox);
  if (!scopedComposerTextIncludes(finalTextbox, task.commentText)) {
    throw new Error("Reply text disappeared before publishing");
  }
  const button = await waitForEnabledButton(finalRoot);
  button.click();
  await delay(3000);
  const replyUrl = await waitForCondition(() => {
    return findReplyUrl(task.commentText, beforeStatusIds, task.statusId);
  }, 25000, 500);
  if (!replyUrl && hasExistingReply(task.commentText)) {
    await stopTask({
      state: "replied",
      completedAt: Date.now(),
      replyUrl: "",
      commentedUrl: ""
    });
    return;
  }
  await stopTask({
    state: "replied",
    completedAt: Date.now(),
    replyUrl: replyUrl || "",
    commentedUrl: replyUrl || ""
  });
}

async function refreshIfNeeded(task) {
  const now = Date.now();
  if (now - scriptStartedAt < TARGET_LOAD_TIMEOUT_MS || now - lastReloadAt < TARGET_LOAD_TIMEOUT_MS) {
    return;
  }

  const targetRefreshCount = Number(task.targetRefreshCount) || 0;
  if (targetRefreshCount >= MAX_TARGET_REFRESH_COUNT) {
    await stopTask({
      state: "error",
      error: "目标帖子 5 秒内加载失败，刷新 3 次后仍未就绪",
      completedAt: Date.now()
    });
    return;
  }

  const nextRefreshCount = targetRefreshCount + 1;
  lastReloadAt = now;

  // 页面刷新后 content script 会重置，刷新次数需要写回任务状态。
  await reportState({
    state: "refreshing",
    reason: isTargetUrl(task) ? "post_not_ready" : "wrong_url",
    targetRefreshCount: nextRefreshCount
  });
  autoLikeTask = {
    ...task,
    state: "refreshing",
    targetRefreshCount: nextRefreshCount
  };

  if (!isTargetUrl(task)) {
    location.assign(task.targetUrl);
    return;
  }

  location.reload();
}

async function tickAutoLike() {
  if (isTicking) {
    return;
  }

  if (!autoLikeTask) {
    return;
  }

  isTicking = true;

  try {
    if (!isPostOpen(autoLikeTask)) {
      await refreshIfNeeded(autoLikeTask);
      return;
    }

    const article = getTargetArticle(autoLikeTask);
    if (!article || !findLikeButton(article) || !findRepostButton(article)) {
      await refreshIfNeeded(autoLikeTask);
      return;
    }

    await ensureLiked(article);
    await ensureReposted(article);

    await publishReply(autoLikeTask);
  } catch (error) {
    await stopTask({ state: "error", error: error.message, completedAt: Date.now() });
  } finally {
    isTicking = false;
  }
}

async function startAutoLike(task) {
  if (task.state === "replied" || task.state === "error") {
    return;
  }

  autoLikeTask = task;
  scriptStartedAt = Date.now();
  window.clearInterval(autoLikeTimer);
  await reportState({ state: "watching" });
  await tickAutoLike();
  if (autoLikeTask) {
    autoLikeTimer = window.setInterval(tickAutoLike, AUTO_LIKE_INTERVAL_MS);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "BROWSE_HOME") {
    return false;
  }

  browseHome({ shouldLike: message.shouldLike !== false })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

(async () => {
  const response = await sendRequiredMessage({ type: "GET_AUTO_LIKE_TASK" });
  if (response.ok && response.task) {
    await startAutoLike(response.task);
  }
})();
