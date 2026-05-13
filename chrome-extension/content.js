(() => {
  const MAIN_SELECTORS = [
    "main",
    "article",
    "[role='main']",
    ".document",
    ".rst-content",
    ".bd-main .bd-content",
    ".main-content"
  ];

  const NOISE_SELECTORS = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "iframe",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "[role='search']",
    ".search",
    ".search-box",
    ".searchbox",
    ".search-form",
    ".toc",
    ".contents",
    ".wy-nav-side",
    ".wy-side-nav-search",
    ".bd-sidebar",
    ".bd-toc",
    ".feedback",
    ".edit-this-page",
    ".copybtn",
    ".headerlink",
    ".skip-link",
    ".pagination",
    ".rst-versions",
    ".cookie-banner",
    ".cookie-consent",
    ".announcement",
    "nav",
    "aside",
    "footer"
  ];

  const PRIMARY_LINK_CONTAINERS = [
    "nav[aria-label*='side' i]",
    "nav[aria-label*='navigation' i]",
    "aside nav",
    ".wy-menu",
    ".wy-nav-content-wrap nav",
    ".bd-sidebar",
    ".sphinxsidebar",
    ".toctree-wrapper",
    ".sidebar",
    ".toc-tree"
  ];

  const RELATED_LINK_SELECTORS = [
    "a[rel='next']",
    "a[rel='prev']",
    ".next a",
    ".prev a",
    ".related a",
    ".breadcrumbs a",
    ".wy-breadcrumbs a",
    "nav[aria-label*='breadcrumb' i] a",
    "[role='navigation'][aria-label*='breadcrumb' i] a"
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "askdocs:extract-page") {
      return undefined;
    }

    try {
      sendResponse({
        ok: true,
        payload: extractPagePayload(),
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
      });
    }

    return false;
  });

  function extractPagePayload() {
    const root = getContentRoot();
    const contentRoot = root || document.body;
    const pageClone = contentRoot.cloneNode(true);

    stripNoise(pageClone);

    return {
      page: {
        url: window.location.href,
        title: document.title.trim(),
        headings: extractHeadings(contentRoot),
        body: extractBodyText(pageClone),
      },
      links: collectCrawlLinks(contentRoot),
    };
  }

  function getContentRoot() {
    for (const selector of MAIN_SELECTORS) {
      const candidate = document.querySelector(selector);
      if (candidate && candidate.textContent && candidate.textContent.trim().length > 120) {
        return candidate;
      }
    }
    return null;
  }

  function stripNoise(root) {
    for (const selector of NOISE_SELECTORS) {
      for (const node of root.querySelectorAll(selector)) {
        node.remove();
      }
    }
  }

  function extractHeadings(root) {
    return [...root.querySelectorAll("h1, h2, h3")]
      .map((node) => compactWhitespace(node.textContent || ""))
      .filter(Boolean)
      .slice(0, 80);
  }

  function extractBodyText(root) {
    const sandbox = document.createElement("div");
    sandbox.style.position = "fixed";
    sandbox.style.left = "-999999px";
    sandbox.style.top = "0";
    sandbox.style.width = "900px";
    sandbox.style.opacity = "0";
    sandbox.style.pointerEvents = "none";
    sandbox.appendChild(root);
    document.body.appendChild(sandbox);

    const text = compactWhitespacePreservingParagraphs(root.innerText || root.textContent || "");
    sandbox.remove();
    return text;
  }

  function collectCrawlLinks(contentRoot) {
    const primary = collectLinksFromContainers(PRIMARY_LINK_CONTAINERS);
    const related = collectLinksFromSelectors(RELATED_LINK_SELECTORS);
    const fallback = collectLinksFromContainer(contentRoot);

    return {
      primary,
      related,
      fallback,
    };
  }

  function collectLinksFromContainers(selectors) {
    const urls = [];
    const seen = new Set();

    for (const selector of selectors) {
      const containers = document.querySelectorAll(selector);
      for (const container of containers) {
        for (const anchor of container.querySelectorAll("a[href]")) {
          const normalizedUrl = normalizeLink(anchor.href);
          if (!normalizedUrl || seen.has(normalizedUrl)) {
            continue;
          }
          seen.add(normalizedUrl);
          urls.push(normalizedUrl);
        }
      }
    }

    return urls;
  }

  function collectLinksFromSelectors(selectors) {
    const urls = [];
    const seen = new Set();

    for (const selector of selectors) {
      const anchors = document.querySelectorAll(selector);
      for (const anchor of anchors) {
        const normalizedUrl = normalizeLink(anchor.href);
        if (!normalizedUrl || seen.has(normalizedUrl)) {
          continue;
        }
        seen.add(normalizedUrl);
        urls.push(normalizedUrl);
      }
    }

    return urls;
  }

  function collectLinksFromContainer(container) {
    const urls = [];
    const seen = new Set();

    for (const anchor of container.querySelectorAll("a[href]")) {
      const normalizedUrl = normalizeLink(anchor.href);
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        continue;
      }
      seen.add(normalizedUrl);
      urls.push(normalizedUrl);
    }

    return urls;
  }

  function normalizeLink(href) {
    if (!href) {
      return null;
    }

    let url;
    try {
      url = new URL(href, window.location.href);
    } catch (_error) {
      return null;
    }

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    if (url.origin !== window.location.origin) {
      return null;
    }
    if (url.hash) {
      url.hash = "";
    }
    if (shouldSkipUrl(url)) {
      return null;
    }

    return url.toString();
  }

  function shouldSkipUrl(url) {
    const pathname = url.pathname.toLowerCase();
    return /\.(zip|tar|gz|bz2|xz|7z|pdf|png|jpg|jpeg|gif|svg|webp|mp4|mp3|mov|avi|css|js|json|xml)$/.test(
      pathname
    );
  }

  function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function compactWhitespacePreservingParagraphs(value) {
    return value
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
})();
