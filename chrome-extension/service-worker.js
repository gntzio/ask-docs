const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";
const DEFAULT_MAX_PAGES = null;
const DEFAULT_MAX_DEPTH = null;
const MAX_ATTEMPTS_PER_PAGE = 2;
const BACKEND_URL_KEY = "backendUrl";
const CRAWL_PACE_KEY = "crawlPace";
const SITE_STATS_PREFIX = "siteStats:";
const HEALTH_CACHE_TTL_MS = 5000;
const PAGE_LOAD_TIMEOUT_MS = 25000;
const FALLBACK_LINK_DEPTH_THRESHOLD = 1;
const DEFAULT_CRAWL_PACE = "normal";
const MAX_SUSPICIOUS_BACKOFF_LEVEL = 4;
const CRAWL_PACE_PROFILES = {
  fast: {
    interPageDelayMs: [350, 850],
    retryDelayMs: [1200, 2200],
    suspiciousBackoffMs: [2600, 4200],
  },
  normal: {
    interPageDelayMs: [800, 1800],
    retryDelayMs: [2200, 3600],
    suspiciousBackoffMs: [4200, 7000],
  },
  gentle: {
    interPageDelayMs: [1600, 3200],
    retryDelayMs: [3600, 5600],
    suspiciousBackoffMs: [6500, 10000],
  },
};

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
    case "setCrawlPace":
      return { state: await setCrawlPace(message.crawlPace) };
    case "requestSiteAccess":
      return await requestSiteAccess(message.origin);
    case "indexSite":
      return { state: await startSiteCrawl(message, { reindex: false }) };
    case "reindexSite":
      return { state: await startSiteCrawl(message, { reindex: true }) };
    case "stopCrawl":
      return { state: await stopSiteCrawl(message) };
    case "retryFailed":
      return { state: await retryFailedPages(message) };
    case "askQuestion":
      return await askQuestion(message);
    default:
      throw new Error("Unknown extension request.");
  }
}

async function ensureDefaults() {
  const values = await chrome.storage.local.get([BACKEND_URL_KEY, CRAWL_PACE_KEY]);
  const defaults = {};

  if (!values[BACKEND_URL_KEY]) {
    defaults[BACKEND_URL_KEY] = DEFAULT_BACKEND_URL;
  }
  if (!values[CRAWL_PACE_KEY]) {
    defaults[CRAWL_PACE_KEY] = DEFAULT_CRAWL_PACE;
  }

  if (Object.keys(defaults).length > 0) {
    await chrome.storage.local.set(defaults);
  }
}

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function buildPanelState(forceHealthCheck) {
  await ensureDefaults();

  const backendUrl = await getBackendUrl();
  const crawlPace = await getStoredCrawlPace();
  const currentSite = await getCurrentSiteState();
  const backendHealth = await checkBackendHealth(backendUrl, forceHealthCheck);
  const crawlState = currentSite.origin ? serializeCrawlJob(crawlJobs.get(currentSite.origin)) : null;
  const siteStats = currentSite.origin ? await getSiteStats(currentSite.origin) : null;

  return {
    backendUrl,
    crawlPace,
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

async function setCrawlPace(rawCrawlPace) {
  const crawlPace = normalizeCrawlPace(rawCrawlPace);
  await chrome.storage.local.set({ [CRAWL_PACE_KEY]: crawlPace });
  return buildPanelState(false);
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
  if (existingJob?.status === "running" || existingJob?.status === "stopping") {
    return buildPanelState(false);
  }

  const seedEntries = (options.seedEntries || [{ url: startUrl, depth: 0 }]).map((entry) => ({
    url: entry.url,
    depth: entry.depth ?? 0,
    attempt: entry.attempt ?? 1,
  }));
  const effectiveStartUrl = seedEntries[0]?.url || startUrl;
  const crawlPace = await getStoredCrawlPace();

  const crawlJob = {
    siteOrigin,
    startUrl: effectiveStartUrl,
    crawlPace,
    paceProfile: getCrawlPaceProfile(crawlPace),
    maxPages: DEFAULT_MAX_PAGES,
    maxDepth: DEFAULT_MAX_DEPTH,
    status: "running",
    pagesVisited: 0,
    pagesIndexed: 0,
    failedPages: 0,
    queueLength: seedEntries.length,
    currentUrl: effectiveStartUrl,
    lastError: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    tabId: null,
    crawlWindowId: null,
    queue: seedEntries,
    queued: new Set(seedEntries.map((entry) => entry.url)),
    known: new Set(seedEntries.map((entry) => entry.url)),
    failedEntries: [],
    followLinks: options.followLinks !== false,
    reindex: Boolean(options.reindex),
    attemptsStarted: 0,
    pendingDelayMs: 0,
    suspiciousBackoffLevel: 0,
    stopRequested: false,
    stopMessage: null,
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
  try {
    if (crawlJob.reindex) {
      await postBackend("/reindex-site", { site: crawlJob.siteOrigin });
      throwIfStopRequested(crawlJob);
    }

    throwIfStopRequested(crawlJob);
    const crawlContainer = await createCrawlerContainer(crawlJob.startUrl);
    crawlJob.tabId = crawlContainer.tabId;
    crawlJob.crawlWindowId = crawlContainer.windowId;

    while (crawlJob.queue.length > 0 && !hasReachedMaxPages(crawlJob)) {
      throwIfStopRequested(crawlJob);

      const nextEntry = crawlJob.queue.shift();
      if (nextEntry) {
        crawlJob.queued.delete(nextEntry.url);
      }
      crawlJob.queueLength = crawlJob.queue.length;

      if (!nextEntry) {
        continue;
      }

      await applyCrawlPacing(crawlJob, nextEntry);
      throwIfStopRequested(crawlJob);
      crawlJob.currentUrl = nextEntry.url;
      crawlJob.attemptsStarted += 1;
      if ((nextEntry.attempt ?? 1) === 1) {
        crawlJob.pagesVisited += 1;
      }

      try {
        const pagePayload = await extractPageFromTab(crawlJob, crawlJob.tabId, nextEntry.url);
        await postBackend("/ingest-page", {
          site: crawlJob.siteOrigin,
          url: pagePayload.page.url,
          title: pagePayload.page.title,
          headings: pagePayload.page.headings,
          body: pagePayload.page.body,
        });
        crawlJob.pagesIndexed += 1;
        crawlJob.failedEntries = crawlJob.failedEntries.filter((entry) => entry.url !== nextEntry.url);
        relaxSuspiciousBackoff(crawlJob);

        if (crawlJob.followLinks && shouldContinueDeeper(crawlJob, nextEntry.depth)) {
          enqueueDiscoveredLinks(crawlJob, pagePayload.links, nextEntry.depth);
        }
      } catch (error) {
        if (isCrawlStoppedError(error)) {
          requestStopCrawl(crawlJob);
          break;
        }

        const errorMessage = toErrorMessage(error);
        noteFailureDelay(crawlJob, errorMessage);
        if ((nextEntry.attempt ?? 1) < MAX_ATTEMPTS_PER_PAGE) {
          enqueueRetryEntry(crawlJob, nextEntry, errorMessage);
        } else {
          recordFailedEntry(crawlJob, nextEntry, errorMessage);
        }
      }

      crawlJob.queueLength = crawlJob.queue.length;
    }

    crawlJob.status = crawlJob.stopRequested ? "stopped" : "completed";
    crawlJob.finishedAt = new Date().toISOString();
    crawlJob.currentUrl = null;
    crawlJob.queueLength = crawlJob.queue.length;
    if (crawlJob.stopRequested) {
      crawlJob.lastError = crawlJob.stopMessage || "Crawl stopped by you.";
    }
  } catch (error) {
    if (isCrawlStoppedError(error)) {
      requestStopCrawl(crawlJob);
      crawlJob.status = "stopped";
      crawlJob.finishedAt = new Date().toISOString();
      crawlJob.currentUrl = null;
      crawlJob.queueLength = crawlJob.queue.length;
      crawlJob.lastError = crawlJob.stopMessage || "Crawl stopped by you.";
      return;
    }
    throw error;
  } finally {
    if (crawlJob.status === "completed" || crawlJob.status === "stopped") {
      const previousSiteStats = await getSiteStats(crawlJob.siteOrigin);
      const totalPagesIndexed = computeStoredPagesIndexed(crawlJob, previousSiteStats);

      await setSiteStats(crawlJob.siteOrigin, {
        lastIndexedAt: crawlJob.finishedAt,
        pagesIndexed: totalPagesIndexed,
        failedPages: crawlJob.failedEntries.length,
        lastStartUrl: crawlJob.startUrl,
        failedEntries: crawlJob.failedEntries,
      });
    }

    await safeRemoveCrawlerContainer(crawlJob);
    crawlJob.tabId = null;
    crawlJob.crawlWindowId = null;
  }
}

async function stopSiteCrawl(message) {
  const siteOrigin = message.siteOrigin || getOriginFromUrl(message.currentPageUrl);
  if (!siteOrigin) {
    throw new Error("Open a supported docs page before stopping a crawl.");
  }

  const crawlJob = crawlJobs.get(siteOrigin);
  if (!crawlJob || (crawlJob.status !== "running" && crawlJob.status !== "stopping")) {
    return buildPanelState(false);
  }

  requestStopCrawl(crawlJob, "Stopping crawl after the current page.");
  return buildPanelState(false);
}

function enqueueDiscoveredLinks(crawlJob, links, currentDepth) {
  const nextDepth = currentDepth + 1;
  let added = 0;
  added += enqueueLinkGroup(crawlJob, links?.primary, nextDepth);
  added += enqueueLinkGroup(crawlJob, links?.related, nextDepth);

  const shouldUseFallback =
    currentDepth <= FALLBACK_LINK_DEPTH_THRESHOLD || added === 0 || crawlJob.queue.length < 5;

  if (shouldUseFallback) {
    enqueueLinkGroup(crawlJob, links?.fallback, nextDepth);
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
    if (crawlJob.known.has(normalizedUrl) || crawlJob.queued.has(normalizedUrl)) {
      continue;
    }

    crawlJob.queue.push({ url: normalizedUrl, depth, attempt: 1 });
    crawlJob.queued.add(normalizedUrl);
    crawlJob.known.add(normalizedUrl);
    added += 1;

    if (hasReachedMaxPages(crawlJob, added + 1)) {
      break;
    }
  }

  crawlJob.queueLength = crawlJob.queue.length;
  return added;
}

function enqueueRetryEntry(crawlJob, entry, errorMessage) {
  crawlJob.lastError = `${errorMessage} Retrying ${entry.url}.`;
  crawlJob.queue.push({
    url: entry.url,
    depth: entry.depth,
    attempt: (entry.attempt ?? 1) + 1,
  });
  crawlJob.queued.add(entry.url);
  crawlJob.queueLength = crawlJob.queue.length;
}

function recordFailedEntry(crawlJob, entry, errorMessage) {
  crawlJob.failedPages += 1;
  crawlJob.lastError = errorMessage;
  const failedEntry = {
    url: entry.url,
    depth: entry.depth,
    attempts: entry.attempt ?? MAX_ATTEMPTS_PER_PAGE,
    error: errorMessage,
  };
  crawlJob.failedEntries = [
    failedEntry,
    ...crawlJob.failedEntries.filter((candidate) => candidate.url !== entry.url),
  ];
}

async function retryFailedPages(message) {
  const siteOrigin = message.siteOrigin || getOriginFromUrl(message.currentPageUrl);
  if (!siteOrigin) {
    throw new Error("Open a supported docs page before retrying failed pages.");
  }

  const siteStats = await getSiteStats(siteOrigin);
  const failedEntries = Array.isArray(siteStats?.failedEntries) ? siteStats.failedEntries : [];
  if (failedEntries.length === 0) {
    throw new Error("There are no failed pages to retry for this site.");
  }

  return startSiteCrawl(message, {
    reindex: false,
    followLinks: false,
    seedEntries: failedEntries.map((entry) => ({
      url: entry.url,
      depth: entry.depth ?? 0,
      attempt: 1,
    })),
  });
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

async function extractPageFromTab(crawlJob, tabId, url) {
  throwIfStopRequested(crawlJob);
  await chrome.tabs.update(tabId, { url, active: false });
  await waitForTabToLoad(crawlJob, tabId, url);
  throwIfStopRequested(crawlJob);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  throwIfStopRequested(crawlJob);
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

async function createCrawlerContainer(url) {
  try {
    const crawlWindow = await chrome.windows.create({
      url,
      focused: false,
      state: "minimized",
      type: "popup",
    });
    let crawlTab = crawlWindow?.tabs?.[0] || null;
    if (crawlWindow?.id && !crawlTab) {
      const tabsInWindow = await chrome.tabs.query({ windowId: crawlWindow.id });
      crawlTab = tabsInWindow[0] || null;
    }
    if (crawlWindow?.id && crawlTab?.id) {
      return {
        windowId: crawlWindow.id,
        tabId: crawlTab.id,
      };
    }
  } catch (_error) {
    // Fall back to an inactive tab in the current window below.
  }

  const fallbackTab = await chrome.tabs.create({
    url,
    active: false,
  });
  return {
    windowId: fallbackTab.windowId,
    tabId: fallbackTab.id,
  };
}

async function safeRemoveCrawlerContainer(crawlJob) {
  try {
    if (crawlJob.crawlWindowId) {
      await chrome.windows.remove(crawlJob.crawlWindowId);
      return;
    }
    if (crawlJob.tabId) {
      await chrome.tabs.remove(crawlJob.tabId);
    }
  } catch (_error) {
    // Ignore cleanup errors when the crawl surface was already removed.
  }
}

async function waitForTabToLoad(crawlJob, tabId, expectedUrl) {
  throwIfStopRequested(crawlJob);

  const currentTab = await chrome.tabs.get(tabId);
  if (currentTab.status === "complete" && normalizeComparableUrl(currentTab.url) === normalizeComparableUrl(expectedUrl)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(stopWatcher);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out while loading ${expectedUrl}.`));
    }, PAGE_LOAD_TIMEOUT_MS);
    const stopWatcher = setInterval(() => {
      if (!crawlJob.stopRequested) {
        return;
      }
      clearTimeout(timer);
      clearInterval(stopWatcher);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new CrawlStoppedError(crawlJob.stopMessage || "Crawl stopped by you."));
    }, 150);

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
      clearInterval(stopWatcher);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onRemoved(removedTabId) {
      if (removedTabId !== tabId) {
        return;
      }
      clearTimeout(timer);
      clearInterval(stopWatcher);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (crawlJob.stopRequested) {
        reject(new CrawlStoppedError(crawlJob.stopMessage || "Crawl stopped by you."));
        return;
      }
      reject(new Error(`Tab closed while loading ${expectedUrl}.`));
    }

    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  await interruptibleDelay(crawlJob, 350);
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

async function getStoredCrawlPace() {
  const values = await chrome.storage.local.get(CRAWL_PACE_KEY);
  return normalizeCrawlPace(values[CRAWL_PACE_KEY] || DEFAULT_CRAWL_PACE);
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
    crawlPace: crawlJob.crawlPace,
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

function computeStoredPagesIndexed(crawlJob, previousSiteStats) {
  if (!crawlJob.followLinks && !crawlJob.reindex) {
    return (previousSiteStats?.pagesIndexed ?? 0) + crawlJob.pagesIndexed;
  }
  if (crawlJob.status === "stopped" && !crawlJob.reindex) {
    return Math.max(previousSiteStats?.pagesIndexed ?? 0, crawlJob.pagesIndexed);
  }
  return crawlJob.pagesIndexed;
}

function normalizeBackendUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    return DEFAULT_BACKEND_URL;
  }
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function normalizeCrawlPace(rawCrawlPace) {
  const candidate = String(rawCrawlPace || "").trim().toLowerCase();
  if (candidate && Object.hasOwn(CRAWL_PACE_PROFILES, candidate)) {
    return candidate;
  }
  return DEFAULT_CRAWL_PACE;
}

function getCrawlPaceProfile(crawlPace) {
  return CRAWL_PACE_PROFILES[normalizeCrawlPace(crawlPace)];
}

function hasReachedMaxPages(crawlJob, additionalQueuedPages = 0) {
  if (crawlJob.maxPages == null) {
    return false;
  }
  return crawlJob.pagesVisited + crawlJob.queue.length + additionalQueuedPages > crawlJob.maxPages;
}

function shouldContinueDeeper(crawlJob, currentDepth) {
  if (crawlJob.maxDepth == null) {
    return true;
  }
  return currentDepth < crawlJob.maxDepth;
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

async function applyCrawlPacing(crawlJob, nextEntry) {
  if (crawlJob.attemptsStarted === 0) {
    crawlJob.pendingDelayMs = 0;
    return;
  }

  const profile = crawlJob.paceProfile || getCrawlPaceProfile(crawlJob.crawlPace);
  const baseDelayMs = randomBetween(profile.interPageDelayMs[0], profile.interPageDelayMs[1]);
  const extraDelayMs = crawlJob.pendingDelayMs || 0;
  const totalDelayMs = baseDelayMs + extraDelayMs;
  const roundedDelaySeconds = Math.max(1, Math.round(totalDelayMs / 1000));

  crawlJob.currentUrl = nextEntry.url;
  crawlJob.lastError =
    extraDelayMs > 0
      ? `Backing off for about ${roundedDelaySeconds}s before ${nextEntry.url}.`
      : `Waiting about ${roundedDelaySeconds}s before ${nextEntry.url}.`;

  crawlJob.pendingDelayMs = 0;
  await interruptibleDelay(crawlJob, totalDelayMs);
  crawlJob.lastError = null;
}

function noteFailureDelay(crawlJob, errorMessage) {
  const profile = crawlJob.paceProfile || getCrawlPaceProfile(crawlJob.crawlPace);
  const suspiciousFailure = isSuspiciousFailure(errorMessage);
  const range = suspiciousFailure ? profile.suspiciousBackoffMs : profile.retryDelayMs;
  const baseDelayMs = randomBetween(range[0], range[1]);

  if (suspiciousFailure) {
    crawlJob.suspiciousBackoffLevel = Math.min(
      crawlJob.suspiciousBackoffLevel + 1,
      MAX_SUSPICIOUS_BACKOFF_LEVEL
    );
  }

  const multiplier = suspiciousFailure ? Math.max(1, crawlJob.suspiciousBackoffLevel) : 1;
  const delayMs = baseDelayMs * multiplier;
  crawlJob.pendingDelayMs = Math.max(crawlJob.pendingDelayMs || 0, delayMs);
}

function relaxSuspiciousBackoff(crawlJob) {
  crawlJob.suspiciousBackoffLevel = Math.max(crawlJob.suspiciousBackoffLevel - 1, 0);
}

function isSuspiciousFailure(errorMessage) {
  const normalized = String(errorMessage || "").toLowerCase();
  return [
    "403",
    "429",
    "rate limit",
    "too many requests",
    "access denied",
    "forbidden",
    "challenge",
    "captcha",
    "timed out",
    "timeout",
    "blocked",
    "cloudflare",
  ].some((pattern) => normalized.includes(pattern));
}

function randomBetween(minimum, maximum) {
  const min = Math.max(0, Math.floor(minimum));
  const max = Math.max(min, Math.floor(maximum));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function requestStopCrawl(crawlJob, stopMessage = "Stopping crawl after the current page.") {
  crawlJob.stopRequested = true;
  crawlJob.stopMessage = stopMessage;
  if (crawlJob.status === "running") {
    crawlJob.status = "stopping";
  }
  crawlJob.lastError = stopMessage;
}

function throwIfStopRequested(crawlJob) {
  if (crawlJob.stopRequested) {
    throw new CrawlStoppedError(crawlJob.stopMessage || "Crawl stopped by you.");
  }
}

function isCrawlStoppedError(error) {
  return error instanceof CrawlStoppedError;
}

async function interruptibleDelay(crawlJob, milliseconds) {
  let remainingMilliseconds = Math.max(0, Math.floor(milliseconds));

  while (remainingMilliseconds > 0) {
    throwIfStopRequested(crawlJob);
    const waitForMilliseconds = Math.min(remainingMilliseconds, 150);
    await delay(waitForMilliseconds);
    remainingMilliseconds -= waitForMilliseconds;
  }

  throwIfStopRequested(crawlJob);
}

class CrawlStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CrawlStoppedError";
  }
}

function toErrorMessage(error) {
  return error?.message || String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
