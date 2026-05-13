const state = {
  latest: null,
  questionPending: false,
};

const POLL_INTERVAL_MS = 1500;

const elements = {
  backendUrl: document.querySelector("#backend-url"),
  saveBackendButton: document.querySelector("#save-backend-button"),
  backendHealthBadge: document.querySelector("#backend-health-badge"),
  backendStatus: document.querySelector("#backend-status"),
  siteOrigin: document.querySelector("#site-origin"),
  currentPage: document.querySelector("#current-page"),
  lastIndexed: document.querySelector("#last-indexed"),
  indexedPages: document.querySelector("#indexed-pages"),
  siteAccessBadge: document.querySelector("#site-access-badge"),
  grantAccessButton: document.querySelector("#grant-access-button"),
  indexSiteButton: document.querySelector("#index-site-button"),
  reindexSiteButton: document.querySelector("#reindex-site-button"),
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
  bindEvents();
  refreshState({ forceHealthCheck: true }).catch(renderTopLevelError);
  window.setInterval(() => {
    refreshState().catch(() => {});
  }, POLL_INTERVAL_MS);
});

function bindEvents() {
  elements.saveBackendButton.addEventListener("click", onSaveBackendUrl);
  elements.grantAccessButton.addEventListener("click", onGrantAccess);
  elements.indexSiteButton.addEventListener("click", () => onStartCrawl({ reindex: false }));
  elements.reindexSiteButton.addEventListener("click", () => onStartCrawl({ reindex: true }));
  elements.askButton.addEventListener("click", onAskQuestion);
  elements.sourcesList.addEventListener("click", onSourceClick);
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
    const response = await sendMessage({
      type: "requestSiteAccess",
      origin: currentSite.origin,
    });
    if (!response.granted) {
      throw new Error("Site access was not granted.");
    }
    await refreshState({ forceHealthCheck: false });
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
    elements.indexSiteButton.disabled = false;
    elements.reindexSiteButton.disabled = false;
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

  if (latest && document.activeElement !== elements.backendUrl) {
    elements.backendUrl.value = latest.backendUrl;
  }

  renderBackendStatus(backendHealth);

  elements.siteOrigin.textContent = currentSite?.origin || "Open a docs page";
  elements.currentPage.textContent = currentSite?.currentPageUrl || "No active docs page";
  elements.lastIndexed.textContent = formatTimestamp(siteStats?.lastIndexedAt);
  elements.indexedPages.textContent = String(siteStats?.pagesIndexed ?? 0);

  const canInteractWithSite = Boolean(currentSite?.origin && currentSite?.currentPageUrl);
  const accessGranted = Boolean(currentSite?.hasAccess);

  setBadge(
    elements.siteAccessBadge,
    accessGranted ? "Access granted" : canInteractWithSite ? "Permission needed" : "No site",
    accessGranted ? "success" : canInteractWithSite ? "warning" : "muted"
  );

  elements.grantAccessButton.disabled = !canInteractWithSite || accessGranted;
  elements.indexSiteButton.disabled = !canInteractWithSite || !accessGranted || crawlState?.status === "running";
  elements.reindexSiteButton.disabled = !canInteractWithSite || !accessGranted || crawlState?.status === "running";
  elements.askButton.disabled = !canInteractWithSite || state.questionPending;

  renderCrawlState(crawlState);
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
  const maxPages = crawlState?.maxPages ?? 100;
  const visited = crawlState?.pagesVisited ?? 0;
  const indexed = crawlState?.pagesIndexed ?? 0;
  const failed = crawlState?.failedPages ?? 0;
  const currentUrl = crawlState?.currentUrl || null;

  elements.crawlProgress.max = maxPages;
  elements.crawlProgress.value = Math.min(visited, maxPages);
  elements.crawlCounts.textContent = `${visited} / ${maxPages} pages`;

  if (!crawlState) {
    elements.crawlStatus.textContent = "Idle";
    elements.crawlDetail.textContent = "No crawl in progress.";
    return;
  }

  if (crawlState.status === "running") {
    elements.crawlStatus.textContent = "Running";
    elements.crawlDetail.textContent = currentUrl
      ? `Indexing ${currentUrl} | ${indexed} indexed, ${failed} failed, ${crawlState.queueLength} queued`
      : "Preparing crawl...";
    return;
  }

  if (crawlState.status === "completed") {
    elements.crawlStatus.textContent = "Completed";
    elements.crawlDetail.textContent = `Indexed ${indexed} pages with ${failed} failures.`;
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

function renderAnswer(answer, sources, chunksUsed) {
  elements.answerOutput.textContent = answer;
  elements.answerOutput.classList.remove("muted");
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
  elements.answerOutput.textContent = message;
  elements.answerOutput.classList.remove("muted");
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
