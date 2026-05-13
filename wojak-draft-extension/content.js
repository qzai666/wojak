const AUTO_LIKE_INTERVAL_MS = 3000;
const TARGET_LOAD_TIMEOUT_MS = 10000;
const MAX_TARGET_REFRESH_COUNT = 3;
const SHORT_WAIT_MS = 500;
const UPLOAD_WAIT_MS = 15000;
const REPLY_PUBLISH_WAIT_MS = 5000;
const REPLY_MODAL_CHECK_MS = 2000;
const REPLY_DIALOG_WAIT_MS = 10000;
const REPLY_RECOVER_WAIT_MS = 10000;
const REPLY_RETRY_LIMIT = 3;
const PAGE_RELOAD_WAIT_MS = 15000;

let autoLikeTimer = null;
let autoLikeTask = null;
let lastReloadAt = 0;
let scriptStartedAt = Date.now();
let isTicking = false;
let homeBrowseCancelled = false;

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
  homeBrowseCancelled = false;
  const steps = randomInt(3, 6);
  for (let step = 0; step < steps; step += 1) {
    if (homeBrowseCancelled) {
      return;
    }
    const direction = step > 1 && Math.random() < 0.22 ? -1 : 1;
    const distance = randomInt(220, Math.max(360, Math.floor(window.innerHeight * 0.85))) * direction;
    window.scrollBy({
      top: distance,
      behavior: "smooth"
    });
    await delay(randomInt(900, 2200));
    if (homeBrowseCancelled) {
      return;
    }

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

  const imageUrl = /^https?:\/\//i.test(task.imageAssetPath)
    ? task.imageAssetPath
    : chrome.runtime.getURL(task.imageAssetPath);
  const response = await fetch(imageUrl);
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

function findReplyActionButton(article) {
  const button = article?.querySelector('button[data-testid="reply"]');
  return button && isVisible(button) ? button : null;
}

function findReplyDialog() {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"][aria-labelledby="modal-header"], div[aria-labelledby="modal-header"]')).filter(isVisible);
  return dialogs.find((dialog) => dialog.querySelector(".public-DraftStyleDefault-block")) || null;
}

function hasReplyDialog() {
  return Boolean(Array.from(document.querySelectorAll('div[role="dialog"][aria-labelledby="modal-header"], div[aria-labelledby="modal-header"]')).find(isVisible));
}

async function openReplyDialog(article) {
  const replyButton = findReplyActionButton(article);
  if (!replyButton) {
    throw new Error("Reply action button not found");
  }

  replyButton.scrollIntoView({ block: "center" });
  await delay(500);
  replyButton.click();
  const root = await waitForCondition(findReplyDialog, REPLY_DIALOG_WAIT_MS, 250);
  if (!root) {
    throw new Error("Reply composer did not open");
  }
  return root;
}

function findReplyDraftBlock(root) {
  return Array.from(root.querySelectorAll(".public-DraftStyleDefault-block")).find(isVisible) || null;
}

function findDraftInputElement(draftBlock) {
  return draftBlock?.closest('[contenteditable="true"]') || draftBlock;
}

function placeCursorAtEnd(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function pasteTextIntoTextbox(textbox, text) {
  textbox.scrollIntoView({ block: "center" });
  textbox.focus();
  placeCursorAtEnd(textbox);

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

function execInsertTextboxText(textbox, text) {
  textbox.scrollIntoView({ block: "center" });
  textbox.focus();
  placeCursorAtEnd(textbox);
  document.execCommand("insertText", false, text);
  textbox.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: text
  }));
}

function composerTextIncludes(textbox, text) {
  const expected = normalizeText(cleanCommentText(text));
  const root = findComposerElement(textbox);
  const candidates = [
    textbox.textContent || "",
    textbox.innerText || "",
    root.querySelector('[data-testid="inline_reply_offscreen"]')?.textContent || "",
    Array.from(root.querySelectorAll("div.public-DraftStyleDefault-block"))
      .map((block) => block.textContent || "")
      .join(" "),
    root.textContent || ""
  ];

  return candidates.some((value) => normalizeText(cleanCommentText(value)).includes(expected));
}

function dispatchFinalTextInput(textbox, text) {
  textbox.dispatchEvent(new InputEvent("input", {
    bubbles: true,
      composed: true,
      inputType: "insertText",
      data: text
    }));
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

function composerTextEquals(textbox, text) {
  const expected = normalizeText(cleanCommentText(text));
  const root = findComposerElement(textbox);
  const candidates = [
    textbox.textContent || "",
    textbox.innerText || "",
    root.querySelector('[data-testid="inline_reply_offscreen"]')?.textContent || "",
    Array.from(root.querySelectorAll("div.public-DraftStyleDefault-block"))
      .map((block) => block.textContent || "")
      .join(" ")
  ];

  return candidates.some((value) => normalizeText(cleanCommentText(value)) === expected);
}

async function ensureReplyText(textbox, text) {
  if (composerTextIncludes(textbox, text)) {
    return;
  }

  pasteTextIntoTextbox(textbox, text);
  if (await waitForCondition(() => composerTextIncludes(textbox, text), 1500, 150)) {
    dispatchFinalTextInput(textbox, text);
    return;
  }

  execInsertTextboxText(textbox, text);
  if (await waitForCondition(() => composerTextIncludes(textbox, text), 1500, 150)) {
    dispatchFinalTextInput(textbox, text);
    return;
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
  return textbox.closest('[role="dialog"]') || textbox.closest("article") || findComposerRoot(textbox);
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

function isButtonEnabled(button) {
  return Boolean(button && !button.disabled && button.getAttribute("aria-disabled") !== "true");
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
    const hasNewMedia = mediaMarkerCount(root) > beforeMediaCount;
    const hasComposerMedia = hasImageAttachment(root);
    const button = findTweetSubmitButton(root);
    const buttonReady = isButtonEnabled(button);
    if ((hasInlineReplyPreview(root) || hasComposerMedia || hasNewMedia) && buttonReady && !hasActiveUpload(root)) {
      return;
    }

    if (Date.now() >= relaxedDeadline && buttonReady && !hasActiveUpload(root)) {
      return;
    }

    await delay(SHORT_WAIT_MS);
  }

  throw new Error("Image attachment preview did not appear");
}

function findTweetSubmitButton(root) {
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

function findReplySubmitButton(root) {
  return root.querySelector('button[data-testid="tweetButton"]');
}

function findHomePostTextbox() {
  const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"][contenteditable="true"], [data-testid="tweetTextarea_0"] [contenteditable="true"], div[role="textbox"][contenteditable="true"]'));
  return boxes.find((box) => isVisible(box) && box.getAttribute("aria-label") !== "Search query") || null;
}

async function waitForHomeComposer() {
  if (!location.pathname.startsWith("/home")) {
    location.assign("https://x.com/home");
    await waitForCondition(() => location.pathname.startsWith("/home") && isPageReady(), 10000, 500);
  }
  const textbox = await waitForCondition(findHomePostTextbox, 12000, 300);
  if (!textbox) {
    throw new Error("Home post textbox not found");
  }
  return textbox;
}

function findOriginalPostUrl(text, beforeStatusIds) {
  const targetText = normalizeText(text);
  const articles = Array.from(document.querySelectorAll("article"));
  for (const article of articles) {
    if (!normalizeText(article.textContent || "").includes(targetText)) {
      continue;
    }
    const urls = getArticleStatusUrls(article);
    const postUrl = urls.find((url) => {
      const statusId = statusIdFromUrl(url);
      return statusId && !beforeStatusIds.has(statusId);
    }) || urls[0];
    if (postUrl) {
      return postUrl;
    }
  }
  return "";
}

async function publishOriginalPost(task) {
  const originalText = cleanCommentText(task.originalText);
  if (!originalText) {
    throw new Error("Original text is empty");
  }

  await reportState({ state: "composing" });
  const textbox = await waitForHomeComposer();
  await delay(1500);
  await ensureReplyText(textbox, originalText);
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
  await reportState({ state: "publishing" });
  await delay(5000);
  if (!composerTextIncludes(textbox, originalText)) {
    throw new Error("Original text is not present before publishing");
  }
  const button = await waitForEnabledButton(root);
  button.click();

  const originalUrl = await waitForCondition(() => findOriginalPostUrl(originalText, beforeStatusIds), 25000, 500);
  await stopTask({
    state: "replied",
    completedAt: Date.now(),
    originalUrl: originalUrl || "",
    replyUrl: originalUrl || "",
    commentedUrl: originalUrl || ""
  });
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function cleanCommentText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

async function waitForEnabledButton(root) {
  const deadline = Date.now() + UPLOAD_WAIT_MS + 10000;
  let button = findTweetSubmitButton(root);

  while (!isButtonEnabled(button) && Date.now() < deadline) {
    await delay(SHORT_WAIT_MS);
    button = findTweetSubmitButton(root);
  }

  if (!isButtonEnabled(button)) {
    throw new Error("Reply button did not become enabled");
  }

  return button;
}

async function closeReplyDialog(dialog) {
  const root = dialog && document.contains(dialog) ? dialog : findReplyDialog();
  const closeButton = root?.querySelector('button[data-testid="app-bar-close"]');
  if (closeButton && isVisible(closeButton)) {
    closeButton.click();
  }
}

async function recoverReplyDialog(dialog) {
  await closeReplyDialog(dialog);
  await delay(1000);

  const confirmationDialog = document.querySelector('div[data-testid="confirmationSheetDialog"]');
  const cancelButton = confirmationDialog?.querySelector('button[data-testid="confirmationSheetCancel"]');
  if (cancelButton && isVisible(cancelButton)) {
    cancelButton.click();
  }
  await delay(1000);
}

async function reloadTargetPost(task) {
  location.reload();
  await waitForCondition(() => isPostOpen(task), PAGE_RELOAD_WAIT_MS, SHORT_WAIT_MS);
  await delay(1000);
}

async function waitForReplySubmitButton(root) {
  return waitForCondition(() => {
    const submitButton = findReplySubmitButton(root);
    return isButtonEnabled(submitButton) ? submitButton : null;
  }, REPLY_RECOVER_WAIT_MS, SHORT_WAIT_MS);
}

async function waitForReplyDialogClosed() {
  return waitForCondition(() => !hasReplyDialog(), REPLY_RECOVER_WAIT_MS, REPLY_MODAL_CHECK_MS);
}

async function clickTweetButtonAndWait(root, commentText, beforeStatusIds, targetStatusId) {
  const button = await waitForReplySubmitButton(root);
  if (!button) {
    return { ok: false, reason: "reply_button_timeout" };
  }

  button.scrollIntoView({ block: "center" });
  button.click();

  const dialogClosed = await waitForReplyDialogClosed();
  if (!dialogClosed) {
    return { ok: false, reason: "reply_dialog_stuck" };
  }

  const replyUrl = await waitForCondition(() => findReplyUrl(commentText, beforeStatusIds, targetStatusId), REPLY_PUBLISH_WAIT_MS, 500);
  if (replyUrl) {
    return { ok: true, state: "replied", replyUrl };
  }

  location.assign("https://x.com/home");
  return { ok: true, state: "spam_reply", replyUrl: "", error: "链接已被风控" };
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
  homeBrowseCancelled = false;
  const shouldLike = options.shouldLike !== false;
  if (!location.pathname.startsWith("/home")) {
    location.assign("https://x.com/home");
    await waitForCondition(() => location.pathname.startsWith("/home") && isPageReady(), 8000, 500);
  }

  await waitForCondition(() => isPageReady() && document.querySelector("article"), 8000, 500);
  // 无任务时先浏览一段首页；是否点赞由后台的首页点赞间隔决定。
  await delay(randomInt(800, 1800));
  if (homeBrowseCancelled) {
    return { browsed: false, liked: false, reason: "cancelled" };
  }
  await humanScrollHome();
  if (homeBrowseCancelled) {
    return { browsed: true, liked: false, reason: "cancelled" };
  }
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
  const commentText = cleanCommentText(task.commentText);
  if (!commentText) {
    throw new Error("Comment text is empty");
  }

  for (let attempt = 0; attempt < REPLY_RETRY_LIMIT; attempt += 1) {
    await reportState({ state: "composing" });
    const article = getTargetArticle(task);
    if (!article) {
      throw new Error("Target article not found");
    }

    let dialog = null;
    try {
      dialog = await openReplyDialog(article);
    } catch (error) {
      if (attempt < REPLY_RETRY_LIMIT - 1 && /Reply composer did not open|Reply action button not found/.test(error.message || "")) {
        await reloadTargetPost(task);
        continue;
      }
      location.assign("https://x.com/home");
      await stopTask({
        state: "error",
        error: "网络问题",
        completedAt: Date.now()
      });
      return;
    }

    const draftBlock = findReplyDraftBlock(dialog);
    if (!draftBlock) {
      throw new Error("Reply draft block not found");
    }
    draftBlock.click();

    const textbox = findDraftInputElement(draftBlock);
    await ensureReplyText(textbox, commentText);
    const root = dialog;

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

    await reportState({ state: "publishing" });
    await delay(5000);
    const publishResult = await clickTweetButtonAndWait(root, commentText, beforeStatusIds, task.statusId);
    const replyUrl = publishResult.replyUrl || "";
    if (publishResult.state === "spam_reply") {
      await stopTask({
        state: "spam_reply",
        completedAt: Date.now(),
        error: publishResult.error || "链接已被风控",
        replyUrl: "",
        commentedUrl: ""
      });
      return;
    }
    if (publishResult.state === "replied") {
      await stopTask({
        state: "replied",
        completedAt: Date.now(),
        replyUrl: replyUrl || "",
        commentedUrl: replyUrl || ""
      });
      return;
    }

    if (attempt < REPLY_RETRY_LIMIT - 1) {
      await recoverReplyDialog(dialog);
      continue;
    }

    await closeReplyDialog(dialog);
    location.assign("https://x.com/home");
    await stopTask({
      state: "error",
      error: "网络问题",
      completedAt: Date.now()
    });
    return;
  }
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
      error: "目标帖子 10 秒内加载失败，刷新 3 次后仍未就绪",
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
    if (autoLikeTask.type === "original") {
      await publishOriginalPost(autoLikeTask);
      return;
    }

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
  if (message?.type === "STOP_HOME_BROWSE") {
    homeBrowseCancelled = true;
    sendResponse({ ok: true });
    return true;
  }

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
