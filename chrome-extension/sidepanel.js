const state = {
  latest: null,
  questionPending: false,
};

const POLL_INTERVAL_MS = 1500;
const PANEL_STATE_STORAGE_KEY = "askdocs:panel-state";

const elements = {
  backendPanel: document.querySelector("#backend-panel"),
  backendUrl: document.querySelector("#backend-url"),
  saveBackendButton: document.querySelector("#save-backend-button"),
  backendHealthBadge: document.querySelector("#backend-health-badge"),
  backendStatus: document.querySelector("#backend-status"),
  currentSitePanel: document.querySelector("#current-site-panel"),
  siteOrigin: document.querySelector("#site-origin"),
  currentPage: document.querySelector("#current-page"),
  lastIndexed: document.querySelector("#last-indexed"),
  indexedPages: document.querySelector("#indexed-pages"),
  siteAccessBadge: document.querySelector("#site-access-badge"),
  grantAccessButton: document.querySelector("#grant-access-button"),
  indexSiteButton: document.querySelector("#index-site-button"),
  reindexSiteButton: document.querySelector("#reindex-site-button"),
  stopCrawlButton: document.querySelector("#stop-crawl-button"),
  crawlPace: document.querySelector("#crawl-pace"),
  retryFailedContainer: document.querySelector("#retry-failed-container"),
  retryFailedButton: document.querySelector("#retry-failed-button"),
  failedSummary: document.querySelector("#failed-summary"),
  crawlStatus: document.querySelector("#crawl-status"),
  crawlCounts: document.querySelector("#crawl-counts"),
  crawlProgress: document.querySelector("#crawl-progress"),
  crawlDetail: document.querySelector("#crawl-detail"),
  questionInput: document.querySelector("#question-input"),
  askButton: document.querySelector("#ask-button"),
  answerMeta: document.querySelector("#answer-meta"),
  answerOutput: document.querySelector("#answer-output"),
  sourcesList: document.querySelector("#sources-list"),
};

document.addEventListener("DOMContentLoaded", () => {
  restorePanelState();
  bindEvents();
  refreshState({ forceHealthCheck: true }).catch(renderTopLevelError);
  window.setInterval(() => {
    refreshState().catch(() => {});
  }, POLL_INTERVAL_MS);
});

function bindEvents() {
  bindPanelToggles();
  elements.saveBackendButton.addEventListener("click", onSaveBackendUrl);
  elements.grantAccessButton.addEventListener("click", onGrantAccess);
  elements.indexSiteButton.addEventListener("click", () => onStartCrawl({ reindex: false }));
  elements.reindexSiteButton.addEventListener("click", () => onStartCrawl({ reindex: true }));
  elements.stopCrawlButton.addEventListener("click", onStopCrawl);
  elements.crawlPace.addEventListener("change", onChangeCrawlPace);
  elements.retryFailedButton.addEventListener("click", onRetryFailed);
  elements.questionInput.addEventListener("keydown", onQuestionKeydown);
  elements.askButton.addEventListener("click", onAskQuestion);
  elements.sourcesList.addEventListener("click", onSourceClick);
}

function bindPanelToggles() {
  elements.backendPanel.addEventListener("toggle", persistPanelState);
  elements.currentSitePanel.addEventListener("toggle", persistPanelState);
}

async function refreshState(options = {}) {
  const response = await sendMessage({
    type: "getState",
    forceHealthCheck: Boolean(options.forceHealthCheck),
  });
  state.latest = response.state;
  renderState();
}

async function onSaveBackendUrl() {
  const backendUrl = elements.backendUrl.value.trim();
  elements.saveBackendButton.disabled = true;
  try {
    const response = await sendMessage({
      type: "setBackendUrl",
      backendUrl,
    });
    state.latest = response.state;
    renderState();
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    elements.saveBackendButton.disabled = false;
  }
}

async function onGrantAccess() {
  const currentSite = state.latest?.currentSite;
  if (!currentSite?.origin) {
    renderTopLevelError(new Error("Open a docs page before requesting access."));
    return;
  }

  elements.grantAccessButton.disabled = true;
  try {
    const originPattern = originToPattern(currentSite.origin);
    const alreadyGranted = await chrome.permissions.contains({
      origins: [originPattern],
    });

    if (!alreadyGranted) {
      const granted = await chrome.permissions.request({
        origins: [originPattern],
      });
      if (!granted) {
        throw new Error("Site access was not granted.");
      }
    }

    await refreshState({ forceHealthCheck: false });
    setAnswerMessage(
      `Access granted for ${currentSite.origin}. You can now index pages from this site.`,
      "Ready"
    );
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    elements.grantAccessButton.disabled = false;
  }
}

async function onStartCrawl({ reindex }) {
  const currentSite = state.latest?.currentSite;
  if (!currentSite?.currentPageUrl || !currentSite?.origin) {
    renderTopLevelError(new Error("Open a docs page to start indexing."));
    return;
  }

  setAnswerMessage(
    reindex
      ? "Re-index requested. Clearing the current site index and starting a fresh crawl."
      : "Indexing requested. AskDocs is opening background tabs and sending pages to the backend.",
    "Working..."
  );

  elements.indexSiteButton.disabled = true;
  elements.reindexSiteButton.disabled = true;

  try {
    const response = await sendMessage({
      type: reindex ? "reindexSite" : "indexSite",
      currentPageUrl: currentSite.currentPageUrl,
      siteOrigin: currentSite.origin,
    });
    state.latest = response.state;
    renderState();
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    if (state.latest) {
      renderState();
    }
  }
}

async function onChangeCrawlPace() {
  const crawlPace = elements.crawlPace.value;
  elements.crawlPace.disabled = true;
  try {
    const response = await sendMessage({
      type: "setCrawlPace",
      crawlPace,
    });
    state.latest = response.state;
    renderState();
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    elements.crawlPace.disabled = false;
  }
}

async function onStopCrawl() {
  const currentSite = state.latest?.currentSite;
  if (!currentSite?.origin || !currentSite?.currentPageUrl) {
    renderTopLevelError(new Error("Open a docs page before stopping a crawl."));
    return;
  }

  elements.stopCrawlButton.disabled = true;
  setAnswerMessage(
    `Stopping the crawl for ${currentSite.origin}. AskDocs will finish the current step and close the background tab.`,
    "Working..."
  );

  try {
    const response = await sendMessage({
      type: "stopCrawl",
      currentPageUrl: currentSite.currentPageUrl,
      siteOrigin: currentSite.origin,
    });
    state.latest = response.state;
    renderState();
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    if (state.latest) {
      renderState();
    }
  }
}

async function onAskQuestion() {
  const query = elements.questionInput.value.trim();
  const currentSite = state.latest?.currentSite;

  if (!query) {
    renderTopLevelError(new Error("Enter a question first."));
    return;
  }
  if (!currentSite?.origin || !currentSite?.currentPageUrl) {
    renderTopLevelError(new Error("Open a docs page before asking a question."));
    return;
  }

  state.questionPending = true;
  renderState();
  setAnswerMessage("AskDocs is asking the backend for a grounded answer.", "Working...");
  clearSources();

  try {
    const response = await sendMessage({
      type: "askQuestion",
      siteOrigin: currentSite.origin,
      currentPageUrl: currentSite.currentPageUrl,
      query,
    });
    renderAnswer(response.answer, response.sources, response.chunksUsed);
    await refreshState({ forceHealthCheck: false });
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    state.questionPending = false;
    renderState();
  }
}

function onQuestionKeydown(event) {
  if (event.isComposing) {
    return;
  }
  if (event.key !== "Enter" || !event.ctrlKey) {
    return;
  }
  if (elements.askButton.disabled) {
    return;
  }

  event.preventDefault();
  onAskQuestion();
}

async function onRetryFailed() {
  const currentSite = state.latest?.currentSite;
  const siteStats = state.latest?.siteStats;
  const failedEntries = Array.isArray(siteStats?.failedEntries) ? siteStats.failedEntries : [];

  if (!currentSite?.origin || !currentSite?.currentPageUrl) {
    renderTopLevelError(new Error("Open a docs page before retrying failed pages."));
    return;
  }
  if (failedEntries.length === 0) {
    renderTopLevelError(new Error("There are no failed pages to retry for this site."));
    return;
  }

  elements.retryFailedButton.disabled = true;
  setAnswerMessage(
    `Retrying ${failedEntries.length} failed page${failedEntries.length === 1 ? "" : "s"} for ${currentSite.origin}.`,
    "Working..."
  );

  try {
    const response = await sendMessage({
      type: "retryFailed",
      currentPageUrl: currentSite.currentPageUrl,
      siteOrigin: currentSite.origin,
    });
    state.latest = response.state;
    renderState();
  } catch (error) {
    renderTopLevelError(error);
  } finally {
    if (state.latest) {
      renderState();
    }
  }
}

function onSourceClick(event) {
  const sourceButton = event.target.closest("[data-source-url]");
  if (!sourceButton) {
    return;
  }
  const url = sourceButton.dataset.sourceUrl;
  if (!url) {
    return;
  }
  chrome.tabs.create({ url }).catch(() => {});
}

function renderState() {
  const latest = state.latest;
  const currentSite = latest?.currentSite;
  const crawlState = latest?.crawlState;
  const siteStats = latest?.siteStats;
  const backendHealth = latest?.backendHealth;
  const crawlPace = latest?.crawlPace || "normal";

  if (latest && document.activeElement !== elements.backendUrl) {
    elements.backendUrl.value = latest.backendUrl;
  }
  if (elements.crawlPace.value !== crawlPace) {
    elements.crawlPace.value = crawlPace;
  }

  renderBackendStatus(backendHealth);

  elements.siteOrigin.textContent = currentSite?.origin || "Open a docs page";
  elements.currentPage.textContent = currentSite?.currentPageUrl || "No active docs page";
  elements.lastIndexed.textContent = formatTimestamp(siteStats?.lastIndexedAt);
  elements.indexedPages.textContent = String(siteStats?.pagesIndexed ?? 0);

  const canInteractWithSite = Boolean(currentSite?.origin && currentSite?.currentPageUrl);
  const accessGranted = Boolean(currentSite?.hasAccess);
  const crawlStatus = crawlState?.status || null;
  const crawlActive = crawlStatus === "running" || crawlStatus === "stopping";
  const crawlStopping = crawlStatus === "stopping";

  setBadge(
    elements.siteAccessBadge,
    accessGranted ? "Access granted" : canInteractWithSite ? "Permission needed" : "No site",
    accessGranted ? "success" : canInteractWithSite ? "warning" : "muted"
  );

  elements.grantAccessButton.disabled = !canInteractWithSite || accessGranted;
  elements.indexSiteButton.disabled = !canInteractWithSite || !accessGranted || crawlActive;
  elements.reindexSiteButton.disabled = !canInteractWithSite || !accessGranted || crawlActive;
  elements.stopCrawlButton.classList.toggle("is-hidden", !crawlActive);
  elements.stopCrawlButton.disabled = !canInteractWithSite || !crawlActive || crawlStopping;
  elements.crawlPace.disabled = crawlActive;
  const retryFailedCount = Array.isArray(siteStats?.failedEntries) ? siteStats.failedEntries.length : 0;
  const showRetryFailed = retryFailedCount > 0 && !crawlActive;
  elements.retryFailedContainer.classList.toggle("is-hidden", !showRetryFailed);
  elements.retryFailedButton.disabled =
    !canInteractWithSite || !accessGranted || crawlActive || retryFailedCount === 0;
  elements.retryFailedButton.textContent = `Retry failed (${retryFailedCount})`;
  elements.failedSummary.textContent = formatFailedSummary(siteStats?.failedEntries);
  elements.askButton.disabled = !canInteractWithSite || state.questionPending;

  renderCrawlState(crawlState);
}

function restorePanelState() {
  try {
    const rawValue = window.localStorage.getItem(PANEL_STATE_STORAGE_KEY);
    if (!rawValue) {
      return;
    }
    const panelState = JSON.parse(rawValue);
    if (typeof panelState.backendOpen === "boolean") {
      elements.backendPanel.open = panelState.backendOpen;
    }
    if (typeof panelState.currentSiteOpen === "boolean") {
      elements.currentSitePanel.open = panelState.currentSiteOpen;
    }
  } catch (_error) {
    // Ignore invalid saved UI state and keep defaults.
  }
}

function persistPanelState() {
  const panelState = {
    backendOpen: elements.backendPanel.open,
    currentSiteOpen: elements.currentSitePanel.open,
  };
  window.localStorage.setItem(PANEL_STATE_STORAGE_KEY, JSON.stringify(panelState));
}

function renderBackendStatus(backendHealth) {
  if (!backendHealth) {
    setBadge(elements.backendHealthBadge, "Unknown", "muted");
    elements.backendStatus.textContent = "No backend health check yet.";
    return;
  }

  if (backendHealth.ok) {
    setBadge(elements.backendHealthBadge, "Reachable", "success");
    elements.backendStatus.textContent = `Backend is healthy at ${backendHealth.url}.`;
    return;
  }

  setBadge(elements.backendHealthBadge, "Unavailable", "danger");
  elements.backendStatus.textContent =
    backendHealth.error || `Backend check failed for ${backendHealth.url}.`;
}

function renderCrawlState(crawlState) {
  const maxPages = crawlState?.maxPages ?? null;
  const visited = crawlState?.pagesVisited ?? 0;
  const indexed = crawlState?.pagesIndexed ?? 0;
  const failed = crawlState?.failedPages ?? 0;
  const currentUrl = crawlState?.currentUrl || null;
  const unlimitedPages = maxPages == null;
  const paceLabel = formatCrawlPaceLabel(crawlState?.crawlPace);

  if (unlimitedPages) {
    elements.crawlProgress.max = Math.max(visited, 1);
    elements.crawlProgress.value = Math.max(visited, 0);
    elements.crawlCounts.textContent = `${visited} / all pages`;
  } else {
    elements.crawlProgress.max = maxPages;
    elements.crawlProgress.value = Math.min(visited, maxPages);
    elements.crawlCounts.textContent = `${visited} / ${maxPages} pages`;
  }

  if (!crawlState) {
    elements.crawlStatus.textContent = "Idle";
    elements.crawlDetail.textContent = "No crawl in progress.";
    return;
  }

  if (crawlState.status === "running") {
    elements.crawlStatus.textContent = "Running";
    if (crawlState.lastError) {
      elements.crawlDetail.textContent =
        `${paceLabel} pace | ${crawlState.lastError} ` +
        `${indexed} indexed, ${failed} failed, ${crawlState.queueLength} queued`;
      return;
    }
    elements.crawlDetail.textContent = currentUrl
      ? `${paceLabel} pace | Indexing ${currentUrl} | ${indexed} indexed, ${failed} failed, ${crawlState.queueLength} queued`
      : `${paceLabel} pace | Preparing crawl...`;
    return;
  }

  if (crawlState.status === "stopping") {
    elements.crawlStatus.textContent = "Stopping";
    elements.crawlDetail.textContent = crawlState.lastError
      ? `${paceLabel} pace | ${crawlState.lastError} ${indexed} indexed, ${failed} failed, ${crawlState.queueLength} queued`
      : `${paceLabel} pace | Stopping after the current page.`;
    return;
  }

  if (crawlState.status === "completed") {
    elements.crawlStatus.textContent = "Completed";
    elements.crawlDetail.textContent = `${paceLabel} pace | Indexed ${indexed} pages with ${failed} failures.`;
    return;
  }

  if (crawlState.status === "stopped") {
    elements.crawlStatus.textContent = "Stopped";
    elements.crawlDetail.textContent = `${paceLabel} pace | Indexed ${indexed} pages before stopping with ${failed} failures.`;
    return;
  }

  if (crawlState.status === "error") {
    elements.crawlStatus.textContent = "Error";
    elements.crawlDetail.textContent = crawlState.lastError || "The crawl stopped because of an error.";
    return;
  }

  elements.crawlStatus.textContent = "Idle";
  elements.crawlDetail.textContent = "No crawl in progress.";
}

function formatFailedSummary(failedEntries) {
  if (!Array.isArray(failedEntries) || failedEntries.length === 0) {
    return "";
  }

  const [latestFailure] = failedEntries;
  const suffix = failedEntries.length > 1 ? ` ${failedEntries.length} pages still need attention.` : " 1 page still needs attention.";
  if (latestFailure?.error) {
    return `Latest failure: ${latestFailure.error}.${suffix}`;
  }
  return `Some pages still failed to index.${suffix}`;
}

function formatCrawlPaceLabel(crawlPace) {
  if (crawlPace === "fast") {
    return "Fast";
  }
  if (crawlPace === "gentle") {
    return "Gentle";
  }
  return "Normal";
}

function renderAnswer(answer, sources, chunksUsed) {
  renderMarkdownAnswer(answer);
  elements.answerMeta.textContent = `${chunksUsed} chunks used`;
  clearSources();

  if (!Array.isArray(sources) || sources.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const source of sources) {
    const item = document.createElement("li");
    item.className = "source-item";

    const title = document.createElement("div");
    title.className = "source-title";
    title.textContent = source.title || source.url || "Untitled source";
    item.appendChild(title);

    if (source.heading) {
      const heading = document.createElement("div");
      heading.className = "source-heading";
      heading.textContent = source.heading;
      item.appendChild(heading);
    }

    if (source.url) {
      const url = document.createElement("div");
      url.className = "source-url";
      url.textContent = source.url;
      item.appendChild(url);

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "button button-secondary source-link";
      openButton.dataset.sourceUrl = source.url;
      openButton.textContent = "Open source";
      item.appendChild(openButton);
    }

    fragment.appendChild(item);
  }

  elements.sourcesList.appendChild(fragment);
}

function setAnswerMessage(message, meta) {
  renderPlainAnswer(message);
  elements.answerMeta.textContent = meta;
}

function clearSources() {
  elements.sourcesList.replaceChildren();
}

function renderTopLevelError(error) {
  const message = error?.message || String(error);
  setAnswerMessage(message, "Error");
  elements.answerOutput.classList.remove("muted");
}

function renderPlainAnswer(message) {
  elements.answerOutput.replaceChildren(document.createTextNode(String(message || "")));
  elements.answerOutput.classList.remove("muted", "markdown-answer");
}

function renderMarkdownAnswer(markdown) {
  const fragment = createMarkdownFragment(markdown);
  elements.answerOutput.replaceChildren();
  elements.answerOutput.appendChild(fragment);
  elements.answerOutput.classList.remove("muted");
  elements.answerOutput.classList.add("markdown-answer");
}

function createMarkdownFragment(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  let paragraphLines = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let codeBlockLines = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" ").trim());
    fragment.appendChild(paragraph);
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      listType = null;
      listItems = [];
      return;
    }
    const list = document.createElement(listType);
    for (const itemText of listItems) {
      const item = document.createElement("li");
      appendInlineMarkdown(item, itemText);
      list.appendChild(item);
    }
    fragment.appendChild(list);
    listType = null;
    listItems = [];
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) {
      return;
    }
    const blockquote = document.createElement("blockquote");
    appendInlineMarkdown(blockquote, quoteLines.join(" ").trim());
    fragment.appendChild(blockquote);
    quoteLines = [];
  };

  const flushCodeBlock = () => {
    if (!Array.isArray(codeBlockLines)) {
      return;
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeBlockLines.join("\n");
    pre.appendChild(code);
    fragment.appendChild(pre);
    codeBlockLines = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");

    if (Array.isArray(codeBlockLines)) {
      if (/^```/.test(line.trim())) {
        flushCodeBlock();
      } else {
        codeBlockLines.push(rawLine);
      }
      continue;
    }

    if (/^```/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushQuote();
      codeBlockLines = [];
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(6, headingMatch[1].length + 3);
      const heading = document.createElement(`h${level}`);
      appendInlineMarkdown(heading, headingMatch[2].trim());
      fragment.appendChild(heading);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    if (quoteLines.length > 0) {
      flushQuote();
    }

    const unorderedListMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unorderedListMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(unorderedListMatch[1].trim());
      continue;
    }

    const orderedListMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (orderedListMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(orderedListMatch[1].trim());
      continue;
    }

    if (listType) {
      flushList();
    }

    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCodeBlock();

  if (!fragment.hasChildNodes()) {
    const fallback = document.createElement("p");
    fallback.textContent = "";
    fragment.appendChild(fallback);
  }

  return fragment;
}

function appendInlineMarkdown(parent, text) {
  const pattern =
    /(\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const [fullMatch] = match;
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)));
    }

    const linkText = match[2];
    const linkUrl = match[3];
    const inlineCode = match[4];
    const strongText = match[5] || match[6];
    const emphasisText = match[7] || match[8];

    if (linkText && linkUrl && isSafeMarkdownUrl(linkUrl)) {
      const anchor = document.createElement("a");
      anchor.href = linkUrl;
      anchor.target = "_blank";
      anchor.rel = "noreferrer noopener";
      anchor.textContent = linkText;
      parent.appendChild(anchor);
    } else if (inlineCode) {
      const code = document.createElement("code");
      code.textContent = inlineCode;
      parent.appendChild(code);
    } else if (strongText) {
      const strong = document.createElement("strong");
      strong.textContent = strongText;
      parent.appendChild(strong);
    } else if (emphasisText) {
      const emphasis = document.createElement("em");
      emphasis.textContent = emphasisText;
      parent.appendChild(emphasis);
    } else {
      parent.appendChild(document.createTextNode(fullMatch));
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function isSafeMarkdownUrl(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function setBadge(element, text, tone) {
  element.textContent = text;
  element.className = "badge";
  if (tone === "success") {
    element.classList.add("badge-success");
    return;
  }
  if (tone === "warning") {
    element.classList.add("badge-warning");
    return;
  }
  if (tone === "danger") {
    element.classList.add("badge-danger");
    return;
  }
  element.classList.add("badge-muted");
}

function formatTimestamp(value) {
  if (!value) {
    return "Not indexed yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not indexed yet";
  }
  return date.toLocaleString();
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Extension request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function originToPattern(origin) {
  return `${origin}/*`;
}
