const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_DEPTH = 2;
const BACKEND_URL_KEY = "backendUrl";
const SITE_STATS_PREFIX = "siteStats:";
const HEALTH_CACHE_TTL_MS = 5000;
const PAGE_LOAD_TIMEOUT_MS = 25000;

const crawlJobs = new Map();
let backendHealthCache = null;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await configureSidePanel();
});

chrome.runtime.onStartup.addListener(async () => {
  await configureSidePanel();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "getState":
      return { state: await buildPanelState(Boolean(message.forceHealthCheck)) };
    case "setBackendUrl":
      return { state: await setBackendUrl(message.backendUrl) };
    case "requestSiteAccess":
      return await requestSiteAccess(message.origin);
    case "indexSite":
      return { state: await startSiteCrawl(message, { reindex: false }) };
    case "reindexSite":
      return { state: await startSiteCrawl(message, { reindex: true }) };
    case "askQuestion":
      return await askQuestion(message);
    default:
      throw new Error("Unknown extension request.");
  }
}

async function ensureDefaults() {
  const values = await chrome.storage.local.get(BACKEND_URL_KEY);
  if (!values[BACKEND_URL_KEY]) {
    await chrome.storage.local.set({ [BACKEND_URL_KEY]: DEFAULT_BACKEND_URL });
  }
}

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function buildPanelState(forceHealthCheck) {
  await ensureDefaults();

  const backendUrl = await getBackendUrl();
  const currentSite = await getCurrentSiteState();
  const backendHealth = await checkBackendHealth(backendUrl, forceHealthCheck);
  const crawlState = currentSite.origin ? serializeCrawlJob(crawlJobs.get(currentSite.origin)) : null;
  const siteStats = currentSite.origin ? await getSiteStats(currentSite.origin) : null;

  return {
    backendUrl,
    backendHealth,
    currentSite,
    crawlState,
    siteStats,
  };
}

async function setBackendUrl(rawBackendUrl) {
  const backendUrl = normalizeBackendUrl(rawBackendUrl || DEFAULT_BACKEND_URL);
  await chrome.storage.local.set({ [BACKEND_URL_KEY]: backendUrl });
  backendHealthCache = null;
  return buildPanelState(true);
}

async function requestSiteAccess(origin) {
  const currentOrigin = origin || (await getCurrentSiteState()).origin;
  if (!currentOrigin) {
    throw new Error("Open a docs page before requesting site access.");
  }

  if (await hasOriginAccess(currentOrigin)) {
    return {
      granted: true,
      alreadyGranted: true,
      origin: currentOrigin,
    };
  }

  const granted = await chrome.permissions.request({
    origins: [originToPattern(currentOrigin)],
  });

  return {
    granted,
    alreadyGranted: false,
    origin: currentOrigin,
  };
}

async function startSiteCrawl(message, options) {
  const startUrl = normalizeHttpUrl(message.currentPageUrl);
  const siteOrigin = message.siteOrigin || getOriginFromUrl(startUrl);
  if (!startUrl || !siteOrigin) {
    throw new Error("Open a supported docs page before starting a crawl.");
  }
  if (!(await hasOriginAccess(siteOrigin))) {
    throw new Error("Grant access to the current site before crawling.");
  }

  const backendUrl = await getBackendUrl();
  const backendHealth = await checkBackendHealth(backendUrl, true);
  if (!backendHealth.ok) {
    throw new Error(backendHealth.error || "AskDocs backend is not reachable.");
  }

  const existingJob = crawlJobs.get(siteOrigin);
  if (existingJob?.status === "running") {
    return buildPanelState(false);
  }

  const startTab = await getActiveTab();
  const crawlJob = {
    siteOrigin,
    startUrl,
    maxPages: DEFAULT_MAX_PAGES,
    maxDepth: DEFAULT_MAX_DEPTH,
    status: "running",
    pagesVisited: 0,
    pagesIndexed: 0,
    failedPages: 0,
    queueLength: 1,
    currentUrl: startUrl,
    lastError: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    tabId: null,
    windowId: startTab?.windowId,
    queue: [{ url: startUrl, depth: 0 }],
    queued: new Set([startUrl]),
    visited: new Set(),
    reindex: Boolean(options.reindex),
  };

  crawlJobs.set(siteOrigin, crawlJob);
  runCrawlJob(crawlJob).catch((error) => {
    crawlJob.status = "error";
    crawlJob.lastError = toErrorMessage(error);
    crawlJob.finishedAt = new Date().toISOString();
  });

  return buildPanelState(false);
}

async function runCrawlJob(crawlJob) {
  if (crawlJob.reindex) {
    await postBackend("/reindex-site", { site: crawlJob.siteOrigin });
  }

  crawlJob.tabId = await createCrawlerTab(crawlJob.windowId, crawlJob.startUrl);

  try {
    while (crawlJob.queue.length > 0 && crawlJob.pagesVisited < crawlJob.maxPages) {
      const nextEntry = crawlJob.queue.shift();
      if (nextEntry) {
        crawlJob.queued.delete(nextEntry.url);
      }
      crawlJob.queueLength = crawlJob.queue.length;

      if (!nextEntry || crawlJob.visited.has(nextEntry.url)) {
        continue;
      }

      crawlJob.visited.add(nextEntry.url);
      crawlJob.currentUrl = nextEntry.url;
      crawlJob.pagesVisited += 1;

      try {
        const pagePayload = await extractPageFromTab(crawlJob.tabId, nextEntry.url);
        await postBackend("/ingest-page", {
          site: crawlJob.siteOrigin,
          url: pagePayload.page.url,
          title: pagePayload.page.title,
          headings: pagePayload.page.headings,
          body: pagePayload.page.body,
        });
        crawlJob.pagesIndexed += 1;

        if (nextEntry.depth < crawlJob.maxDepth) {
          enqueueDiscoveredLinks(crawlJob, pagePayload.links, nextEntry.depth + 1);
        }
      } catch (error) {
        crawlJob.failedPages += 1;
        crawlJob.lastError = toErrorMessage(error);
      }

      crawlJob.queueLength = crawlJob.queue.length;
    }

    crawlJob.status = "completed";
    crawlJob.finishedAt = new Date().toISOString();
    crawlJob.currentUrl = null;
    crawlJob.queueLength = 0;

    await setSiteStats(crawlJob.siteOrigin, {
      lastIndexedAt: crawlJob.finishedAt,
      pagesIndexed: crawlJob.pagesIndexed,
      failedPages: crawlJob.failedPages,
      lastStartUrl: crawlJob.startUrl,
    });
  } finally {
    await safeRemoveTab(crawlJob.tabId);
    crawlJob.tabId = null;
  }
}

function enqueueDiscoveredLinks(crawlJob, links, depth) {
  let added = 0;
  added += enqueueLinkGroup(crawlJob, links?.primary, depth);
  added += enqueueLinkGroup(crawlJob, links?.related, depth);

  if (added === 0 || crawlJob.queue.length === 0) {
    enqueueLinkGroup(crawlJob, links?.fallback, depth);
  }
}

function enqueueLinkGroup(crawlJob, urls, depth) {
  if (!Array.isArray(urls)) {
    return 0;
  }

  let added = 0;
  for (const rawUrl of urls) {
    const normalizedUrl = normalizeCrawlUrl(rawUrl, crawlJob.siteOrigin);
    if (!normalizedUrl) {
      continue;
    }
    if (crawlJob.visited.has(normalizedUrl) || crawlJob.queued.has(normalizedUrl)) {
      continue;
    }

    crawlJob.queue.push({ url: normalizedUrl, depth });
    crawlJob.queued.add(normalizedUrl);
    added += 1;

    if (crawlJob.pagesVisited + crawlJob.queue.length >= crawlJob.maxPages) {
      break;
    }
  }

  crawlJob.queueLength = crawlJob.queue.length;
  return added;
}

async function askQuestion(message) {
  const siteOrigin = message.siteOrigin;
  const currentPageUrl = normalizeHttpUrl(message.currentPageUrl);
  const query = String(message.query || "").trim();

  if (!siteOrigin || !currentPageUrl || !query) {
    throw new Error("Question, site, and current page URL are required.");
  }

  const result = await postBackend("/ask", {
    site: siteOrigin,
    query,
    current_page_url: currentPageUrl,
    top_k: 5,
  });

  return {
    answer: result.answer,
    sources: result.sources || [],
    chunksUsed: result.chunks_used || 0,
  };
}

async function extractPageFromTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: false });
  await waitForTabToLoad(tabId, url);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "askdocs:extract-page",
  });
  if (!response?.ok) {
    throw new Error(response?.error || `Could not extract page content from ${url}.`);
  }
  if (!response.payload?.page?.body) {
    throw new Error(`The page at ${url} did not produce extractable content.`);
  }
  return response.payload;
}

async function createCrawlerTab(windowId, url) {
  const createProperties = {
    url,
    active: false,
  };
  if (typeof windowId === "number") {
    createProperties.windowId = windowId;
  }
  const tab = await chrome.tabs.create(createProperties);
  return tab.id;
}

async function safeRemoveTab(tabId) {
  if (!tabId) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (_error) {
    // Ignore cleanup errors when the tab was already removed.
  }
}

async function waitForTabToLoad(tabId, expectedUrl) {
  const currentTab = await chrome.tabs.get(tabId);
  if (currentTab.status === "complete" && normalizeComparableUrl(currentTab.url) === normalizeComparableUrl(expectedUrl)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out while loading ${expectedUrl}.`));
    }, PAGE_LOAD_TIMEOUT_MS);

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status !== "complete") {
        return;
      }
      if (normalizeComparableUrl(tab.url) !== normalizeComparableUrl(expectedUrl)) {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  await delay(350);
}

async function getCurrentSiteState() {
  const activeTab = await getActiveTab();
  const currentPageUrl = normalizeHttpUrl(activeTab?.url || null);
  const origin = getOriginFromUrl(currentPageUrl);

  return {
    origin,
    currentPageUrl,
    title: activeTab?.title || "",
    hasAccess: origin ? await hasOriginAccess(origin) : false,
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tabs[0] || null;
}

async function hasOriginAccess(origin) {
  return chrome.permissions.contains({
    origins: [originToPattern(origin)],
  });
}

async function getBackendUrl() {
  const values = await chrome.storage.local.get(BACKEND_URL_KEY);
  return normalizeBackendUrl(values[BACKEND_URL_KEY] || DEFAULT_BACKEND_URL);
}

async function checkBackendHealth(backendUrl, force) {
  const now = Date.now();
  if (
    !force &&
    backendHealthCache &&
    backendHealthCache.url === backendUrl &&
    now - backendHealthCache.checkedAt < HEALTH_CACHE_TTL_MS
  ) {
    return backendHealthCache;
  }

  let health;
  try {
    const response = await fetch(`${backendUrl}/health`, {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    health = {
      ok: payload.status === "ok",
      url: backendUrl,
      checkedAt: now,
      error: payload.status === "ok" ? null : "Backend health check failed.",
    };
  } catch (error) {
    health = {
      ok: false,
      url: backendUrl,
      checkedAt: now,
      error: `Could not reach backend at ${backendUrl}: ${toErrorMessage(error)}`,
    };
  }

  backendHealthCache = health;
  return health;
}

async function postBackend(pathname, payload) {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let parsedBody = null;

  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (_error) {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    const detail = parsedBody?.detail || rawBody || `HTTP ${response.status}`;
    throw new Error(`Backend request to ${pathname} failed: ${detail}`);
  }

  return parsedBody || {};
}

async function getSiteStats(siteOrigin) {
  const key = `${SITE_STATS_PREFIX}${siteOrigin}`;
  const values = await chrome.storage.local.get(key);
  return values[key] || null;
}

async function setSiteStats(siteOrigin, stats) {
  const key = `${SITE_STATS_PREFIX}${siteOrigin}`;
  await chrome.storage.local.set({
    [key]: stats,
  });
}

function serializeCrawlJob(crawlJob) {
  if (!crawlJob) {
    return null;
  }
  return {
    siteOrigin: crawlJob.siteOrigin,
    startUrl: crawlJob.startUrl,
    status: crawlJob.status,
    maxPages: crawlJob.maxPages,
    maxDepth: crawlJob.maxDepth,
    pagesVisited: crawlJob.pagesVisited,
    pagesIndexed: crawlJob.pagesIndexed,
    failedPages: crawlJob.failedPages,
    queueLength: crawlJob.queueLength,
    currentUrl: crawlJob.currentUrl,
    lastError: crawlJob.lastError,
    startedAt: crawlJob.startedAt,
    finishedAt: crawlJob.finishedAt,
  };
}

function normalizeBackendUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    return DEFAULT_BACKEND_URL;
  }
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function normalizeHttpUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function normalizeCrawlUrl(rawUrl, siteOrigin) {
  const normalizedUrl = normalizeHttpUrl(rawUrl);
  if (!normalizedUrl) {
    return null;
  }
  const url = new URL(normalizedUrl);
  if (url.origin !== siteOrigin) {
    return null;
  }
  url.hash = "";
  if (shouldSkipUrl(url)) {
    return null;
  }
  return url.toString();
}

function normalizeComparableUrl(rawUrl) {
  const normalizedUrl = normalizeHttpUrl(rawUrl);
  if (!normalizedUrl) {
    return "";
  }
  const url = new URL(normalizedUrl);
  url.hash = "";
  return url.toString();
}

function shouldSkipUrl(url) {
  return /\.(zip|tar|gz|bz2|xz|7z|pdf|png|jpg|jpeg|gif|svg|webp|mp4|mp3|mov|avi|css|js|json|xml)$/i.test(
    url.pathname
  );
}

function getOriginFromUrl(rawUrl) {
  const normalizedUrl = normalizeHttpUrl(rawUrl);
  if (!normalizedUrl) {
    return null;
  }
  return new URL(normalizedUrl).origin;
}

function originToPattern(origin) {
  return `${origin}/*`;
}

function toErrorMessage(error) {
  return error?.message || String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
