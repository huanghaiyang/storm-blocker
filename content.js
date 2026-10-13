/*!
 * 风暴屏蔽器 — 内容脚本
 *
 * 工作方式：找到"视频卡片 → UP 主名字"，命中名单就给卡片打上
 * data-sb-hidden 属性，由 content.css 负责隐藏/淡化。
 * 这样在 SPA 里反复重渲染也不会闪烁。
 */
(function () {
  'use strict';

  if (window.__stormBlockerLoaded) return;
  window.__stormBlockerLoaded = true;

  const SB = window.StormBlock;
  if (!SB) return;

  /* ------------------------------------------------------------------ *
   * 站点适配表
   * ------------------------------------------------------------------ */

  /** 视频卡片的候选容器，选第一个能匹配上的。 */
  const CARD_SELECTORS = {
    bilibili: [
      '.bili-video-card',
      '.feed-card',
      '.bili-dyn-item',
      '.bili-dyn-list__item',
      '.video-page-card-small',
      '.video-page-special-card-small',
      '.search-page-video',
      '.search-video-card',
      '.video-card',
      '.small-item',
      '.rank-item',
      '.video-item',
      // 搜索页的两种非视频卡片：
      // 课程/活动推广横条，以及 UP 主名片（头像 + 粉丝数 + 关注按钮）
      '.activity-card',
      '.b-user-video-card',
    ],
    youtube: [
      'ytd-rich-item-renderer',
      'ytd-rich-grid-media',
      'ytd-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-playlist-video-renderer',
      'ytd-reel-item-renderer',
      'ytd-reel-video-renderer',
      'yt-lockup-view-model',
      'ytd-rich-grid-slim-media',
    ],
  };

  /** UP 主 / 频道名的候选选择器。 */
  const AUTHOR_SELECTORS = {
    bilibili: [
      '.bili-video-card__info--author',
      '.bili-video-card__info--owner .bili-video-card__info--author',
      '.up-name',
      '.bili-dyn-title__text',
      '.bili-dyn-item__author',
      '.name',
      '.upname',
      '.author',
      '.video-card__info--author',
      // UP 主名片：名字在 user-name 里
      '.user-name',
      // 课程/活动推广横条：UP 主名字只出现在描述里
      '.activity-card-content-head-desc',
    ],
    youtube: [
      'ytd-channel-name #text',
      'ytd-channel-name a',
      '#channel-name #text',
      '#channel-name a',
      '.yt-content-metadata-view-model__metadata-row:last-child .yt-core-attributed-string',
      '.yt-content-metadata-view-model__metadata-row:last-child span',
      '.ytd-video-meta-block #channel-name',
      '.yt-lockup-metadata-view-model__metadata .yt-core-attributed-string',
      '#byline-container #text',
      '.ytd-channel-name',
    ],
  };

  /**
   * 兜底用："UP 主主页链接"。
   * 名字的 class 改版时常常还在，但万一整个信息区都换了，
   * 视频卡片里指向 space.bilibili.com 的链接依然是最可靠的抓手。
   * 只扫描已经判定为卡片的元素内部，避免误伤侧栏/顶栏的推荐位。
   */
  const AUTHOR_LINK_SELECTORS = {
    bilibili: ['a[href*="space.bilibili.com"]'],
    youtube: [],
  };

  /** 标题的候选选择器，用于按标题关键词屏蔽（可选功能）。 */
  const TITLE_SELECTORS = {
    bilibili: ['.bili-video-card__info--tit', '.title', '.video-name', '.bili-dyn-title__text', 'h3', 'a.title'],
    youtube: [
      '#video-title',
      'yt-formatted-string#video-title',
      '.yt-lockup-metadata-view-model__title',
      '.yt-lockup-metadata-view-model-wiz__title',
      'h3 a span',
      'h3 span',
      '#video-title-link',
    ],
  };

  function detectSite() {
    const host = location.hostname;
    if (/(^|\.)bilibili\.com$/.test(host)) return 'bilibili';
    if (/(^|\.)youtube\.com$/.test(host)) return 'youtube';
    return null;
  }

  const SITE = detectSite();

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  let config = SB.normalizeConfig(null);
  let uploaderMatcher = SB.buildMatcher(config.blockedUploaders);
  let titleMatcher = SB.buildMatcher(config.blockedTitles);

  /** 被我们打过标记的元素（跨重渲染累计），用于统计与还原。 */
  const hiddenEls = new Set();
  /** 本页面见过的、命中的 UP 主名字，popup 里展示用。 */
  const matchedNames = new Set();
  /** 每个卡片缓存它的判定结果，避免重复计算。名单变化时整体换新。 */
  let cardCache = new WeakMap();

  let scanScheduled = false;
  let scanTimer = null;
  let lastScanAt = 0;
  let toastTimer = null;
  let toastShownAt = 0;

  /** 两次真正扫描之间的最小间隔（毫秒），防止滚动时反复重扫 */
  const MIN_SCAN_INTERVAL = 150;

  /* ------------------------------------------------------------------ *
   * DOM 小工具
   * ------------------------------------------------------------------ */

  function textOf(el) {
    if (!el) return '';
    const t = el.textContent;
    return t ? SB.normalizeName(t) : '';
  }

  /** 看起来只是"上传时间"而不是名字： " · 9月16日"、"· 昨天"、" · 2021年5月15日" */
  function looksLikeName(text) {
    if (!text) return false;
    const core = String(text).replace(/[-·•・‧|丨\s]/g, '');
    if (!core) return false;
    // 只有日期/时间用到的字和数字（"9月16日"、"昨天"、"2021年5月15日"），没有名字
    return !/^[\d年月日时分秒天周小时前昨今早凌晨]+$/.test(core);
  }

  /** 依次尝试候选选择器，返回第一个有文字的结果。 */
  function firstText(scope, selectors) {
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = scope.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      for (const node of nodes) {
        const t = textOf(node);
        if (t) return t;
      }
    }
    return '';
  }

  /** 取最后一个有文字的结果（YouTube 的频道名一般排在元信息末尾）。 */
  function lastText(scope, selectors) {
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = scope.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const t = textOf(nodes[i]);
        if (t) return t;
      }
    }
    return '';
  }

  /**
   * 从卡片内部任意节点出发，找到"整个视频卡片"那个容器。
   * 先看祖先/后代里有没有站点已知的卡片容器，再按尺寸启发式兜底 ——
   * 两站改版都很勤，纯靠 class 迟早会失效。
   */
  function resolveCardTarget(el) {
    const known = CARD_SELECTORS[SITE].join(',');
    const isRoot = (node) => node && node !== document.body && node !== document.documentElement;

    const ancestor = el.closest(known);
    if (isRoot(ancestor)) {
      // 卡片容器本身是嵌套的（ytd-rich-item-renderer > ytd-rich-grid-media），
      // 取最外面那一层，整块一起隐藏，避免留下一块空白占位。
      let outermost = ancestor;
      let up = ancestor.parentElement;
      while (up) {
        if (up.matches && up.matches(known) && isRoot(up)) outermost = up;
        up = up.parentElement;
      }
      return outermost;
    }

    if (typeof el.querySelector === 'function') {
      const descendant = el.querySelector(known);
      if (descendant) {
        const owner = descendant.closest(known);
        if (isRoot(owner)) return owner;
      }
    }

    let node = el;
    let best = el;
    for (let i = 0; i < 12 && node && node !== document.body; i += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 240 && rect.height >= 80) best = node;
      node = node.parentElement;
    }
    return best;
  }

  function isAlreadyHiddenByUs(el) {
    if (el.getAttribute('data-sb-hidden')) return true;
    return false;
  }

  /** 元素是否落在"已经被我们隐藏的卡片"里面。 */
  function hasHiddenAncestor(el) {
    const parent = el.parentElement;
    return !!(parent && parent.closest('[data-sb-hidden]'));
  }

  /** 元素是否本来就不可见（例如卡片被折叠在别的 tab 里）。 */
  function isNaturallyInvisible(el) {
    // 已经被我们隐藏的卡片内部的元素，不能算"本来就不可见"：
    // 视频网格里嵌了别的卡片时，父级一隐藏，子级就查不到尺寸了。
    if (hasHiddenAncestor(el)) return false;
    try {
      if (typeof el.checkVisibility === 'function') {
        return !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: false });
      }
    } catch (err) {
      /* 老版本 Chrome 不支持参数，走下面的兜底 */
    }
    if (el.offsetParent === null) {
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(el);
        if (style && style.position !== 'fixed') return true;
      } else {
        return true;
      }
    }
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  }

  /* ------------------------------------------------------------------ *
   * 核心扫描
   * ------------------------------------------------------------------ */

  function scan() {
    scanScheduled = false;
    lastScanAt = Date.now();
    if (!SITE || !config.enabled) return;

    const platformOn = config.platforms[SITE] !== false;
    if (!platformOn) {
      restoreAll();
      return;
    }

    const cardSelector = CARD_SELECTORS[SITE].join(',');
    const authorSelector = AUTHOR_SELECTORS[SITE].join(',');
    const authorSelectors = AUTHOR_SELECTORS[SITE];
    const authorLinkSelectors = AUTHOR_LINK_SELECTORS[SITE] || [];
    const titleSelectors = TITLE_SELECTORS[SITE];

    const seenThisPass = new Set();

    /** 判断一张卡片该不该拦；结果写进 cardCache，同一张卡只算一次。 */
    function considerCard(card) {
      if (!card || card === document.body || card === document.documentElement) return;
      if (seenThisPass.has(card)) return;
      seenThisPass.add(card);

      // 嵌套卡片（外层已经命中并隐藏）由 applyHidden 里的 hasHiddenAncestor 处理：
      // 它不会再打标记，所以下面 "cached === 'hit'" 分支只统计真正带标记的那些。
      const cached = cardCache.get(card);
      if (cached === 'skip') return;

      // 已经判定命中的卡片：如果它自己带着标记，就是"新隐藏一个"（要计数）；
      // 如果它是被别的命中卡片裹在里面的（比如 UP 主名片里的视频网格），
      // 它没有自己的标记，就不该再数一次，否则统计会虚高。
      if (cached === 'hit') {
        if (card.getAttribute('data-sb-hidden')) hiddenEls.add(card);
        return;
      }

      // 只处理真正被渲染出来的卡片，省掉大量无意义的文本匹配
      if (isNaturallyInvisible(card)) return;

      const author = SITE === 'youtube' ? lastText(card, authorSelectors) : firstText(card, authorSelectors);
      let hit = null;
      /** 这一轮到底读到了多少可用信息；决定能不能把结果缓存成 skip。 */
      let evidence = author;

      if (author && uploaderMatcher.match(author)) {
        hit = { kind: 'uploader', name: author };
      } else if (!titleMatcher.isEmpty) {
        const titleText = firstText(card, titleSelectors) || firstText(card, ['#video-title', 'h3', 'a[title]']);
        evidence = evidence || titleText;
        if (titleText && titleMatcher.match(titleText)) hit = { kind: 'title', name: titleText };
      }

      // 名字的 class 全换了也不怕：卡片里指向 UP 主主页的链接还在。
      // 注意：链接文字里可能只有 " · 9月16日"（骨架屏阶段名字还没渲染），
      // 这种不能当证据，否则会给卡片盖上"已检查、不用管"的戳。
      if (!hit && authorLinkSelectors.length) {
        const linkText = firstText(card, authorLinkSelectors);
        if (looksLikeName(linkText)) {
          evidence = evidence || 'link';
          if (uploaderMatcher.match(linkText)) hit = { kind: 'uploader', name: linkText };
        }
      }

      if (!hit) {
        // 关键：只有"确实读到了名字/标题但没命中"才允许缓存 skip。
        // 搜索页、首页的卡片会先以骨架屏出现、名字晚一步渲染，
        // 如果这时候就把卡片记成 skip，之后名字出来了也不会再看 —— 表现就是"只拦掉一部分"。
        if (evidence) cardCache.set(card, 'skip');
        return;
      }

      cardCache.set(card, 'hit');
      applyHidden(card);
      if (hit.kind === 'uploader') matchedNames.add(hit.name);
      else matchedNames.add('标题：' + hit.name);
    }

    // 处理顺序必须"外层优先"：
    // querySelectorAll 是按文档顺序返回的，子节点可能先于祖先出现
    // （UP 主名片 .b-user-video-card 就排在里面那些视频卡片后面）。
    // 先处理外层，内层就能通过 hasHiddenAncestor 认出"已经被裹住了"。
    const depthOf = (el) => {
      let d = 0;
      let node = el.parentElement;
      while (node) {
        d += 1;
        node = node.parentElement;
      }
      return d;
    };

    // 第一遍：站点已知的卡片容器
    let cards = [];
    try {
      cards = Array.prototype.slice.call(document.querySelectorAll(cardSelector));
    } catch (err) {
      cards = [];
    }

    cards.sort((a, b) => depthOf(a) - depthOf(b));
    for (const card of cards) {
      considerCard(card);
    }

    // 第二遍：从 UP 主/频道名节点反查卡片。
    // 站点大改版时卡片 class 可能整个换掉，但只要 UP 主名字的 class 还在就还能拦；
    // 靠 resolveCardTarget 往上/往下找到真正的卡片容器。
    // 注意：这里只补扫第一遍漏掉的卡片，已经判定过的直接跳过（否则会把统计数翻倍）。
    try {
      for (const authorEl of document.querySelectorAll(authorSelector)) {
        if (cardCache.get(authorEl)) continue;
        const card = resolveCardTarget(authorEl);
        if (!card || card === authorEl) continue;
        if (cardCache.get(card)) continue;
        considerCard(card);
      }
    } catch (err) {
      /* 选择器不被支持时忽略这一遍 */
    }

    updateToast();
  }

  function applyHidden(card) {
    if (isAlreadyHiddenByUs(card)) return;
    // 已经有命中卡片把这一块裹住了（例如 UP 主名片里的视频网格），就不再重复打标记
    if (hasHiddenAncestor(card)) return;
    card.setAttribute('data-sb-hidden', config.mode);
    card.setAttribute('data-sb-why', config.mode);
    hiddenEls.add(card);
  }

  function restoreAll() {
    for (const el of hiddenEls) {
      el.removeAttribute('data-sb-hidden');
      el.removeAttribute('data-sb-why');
    }
    hiddenEls.clear();
    matchedNames.clear();
  }

  /** 名单/模式/换页之后统一清场，保证下一轮扫描从零开始。 */
  function resetCaches() {
    restoreAll();
    cardCache = new WeakMap();
  }

  function runScheduledScan() {
    scanTimer = null;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => scan(), { timeout: 200 });
    } else {
      scan();
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // 节流：滚动时 MutationObserver 会疯狂回调，最短 150ms 才真正扫一次
    const wait = Math.max(0, MIN_SCAN_INTERVAL - (Date.now() - lastScanAt));
    scanTimer = setTimeout(runScheduledScan, wait);
  }

  /** 立刻扫一次（配置变更、换页时用），并取消排队中的那次。 */
  function scanNow() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      runScheduledScan();
    } else {
      scan();
    }
  }

  /* ------------------------------------------------------------------ *
   * 角标提示
   * ------------------------------------------------------------------ */

  function updateToast() {
    const count = hiddenEls.size;

    if (!config.showToast || !config.enabled || count === 0) {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      const existing = document.getElementById('sb-toast');
      if (existing) existing.classList.remove('sb-show');
      return;
    }

    // 距上次提示不到 1.5s 就不重复弹，避免滚动时闪个不停
    const now = Date.now();
    const docRoot = document.documentElement;
    let el = document.getElementById('sb-toast');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('id', 'sb-toast');
      (document.body || docRoot).appendChild(el);
    }
    if (el.getAttribute('data-count') === String(count) && now - toastShownAt < 1500) return;
    el.setAttribute('data-count', String(count));
    toastShownAt = now;
    el.innerHTML = '风暴屏蔽器：已拦下 <b>' + count + '</b> 个视频';
    el.classList.add('sb-show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('sb-show');
      toastTimer = null;
    }, 4000);
  }

  /* ------------------------------------------------------------------ *
   * 开关 / 配置
   * ------------------------------------------------------------------ */

  function applyEnabledState() {
    const html = document.documentElement;
    if (!html) return;
    if (config.enabled && config.platforms[SITE] !== false) html.removeAttribute('data-sb-off');
    else html.setAttribute('data-sb-off', '1');
  }

  function applyConfig(next) {
    config = SB.normalizeConfig(next);
    uploaderMatcher = SB.buildMatcher(config.blockedUploaders);
    titleMatcher = SB.buildMatcher(config.blockedTitles);
    applyEnabledState();

    // 名单/模式变了，缓存作废：先还原已标记的，再从零扫一遍
    resetCaches();

    if (config.enabled && config.platforms[SITE] !== false) scanNow();
    else updateToast();
  }

  /* ------------------------------------------------------------------ *
   * 与 popup 通信
   * ------------------------------------------------------------------ */

  function statsPayload() {
    return {
      site: SITE,
      url: location.href,
      count: hiddenEls.size,
      enabled: config.enabled,
      mode: config.mode,
      names: Array.from(matchedNames).slice(0, 20),
    };
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'sb:getStats') return undefined;
      // 同步回包即可，不需要保持消息通道
      sendResponse(statsPayload());
      return undefined;
    });
  } catch (err) {
    /* 扩展被重载时可能拿不到 runtime，忽略即可 */
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SB.STORAGE_KEY]) return;
      applyConfig(changes[SB.STORAGE_KEY].newValue);
    });
  } catch (err) {
    /* 同上 */
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  if (SITE) {
    // 立刻按默认配置把标记打开，避免首屏闪一下才隐藏
    applyEnabledState();

    try {
      chrome.storage.local.get(SB.STORAGE_KEY, (data) => {
        applyConfig(data && data[SB.STORAGE_KEY]);
        scheduleScan();
      });
    } catch (err) {
      scheduleScan();
    }

    const observer = new MutationObserver(() => scheduleScan());
    const startObserver = () => {
      const target = document.body || document.documentElement;
      if (!target) return;
      observer.observe(target, { childList: true, subtree: true });
      scheduleScan();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
      startObserver();
    }

    // SPA 换页（首页→搜索→视频页）后重新扫一遍
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      resetCaches();
      scanNow();
    }, 800);

    // 兜底轮询：某些站点会绕过 MutationObserver 做虚拟列表复用
    setInterval(() => {
      if (config.enabled && config.platforms[SITE] !== false) scheduleScan();
    }, 4000);
  }

  /* ------------------------------------------------------------------ *
   * 测试钩子
   * 单元测试会用一份迷你 DOM 桩来加载本文件，需要能直接调到内部函数。
   * 正常运行时它只是一个挂在 window 上的只读对象，没有副作用。
   * ------------------------------------------------------------------ */

  const testApi = {
    site: SITE,
    scan,
    restoreAll,
    resetCaches,
    applyConfig,
    textOf,
    firstText,
    lastText,
    resolveCardTarget,
    isNaturallyInvisible,
    statsPayload,
    getHiddenCount: () => hiddenEls.size,
    getMatchedNames: () => Array.from(matchedNames),
    getConfig: () => config,
    getCardState: (el) => cardCache.get(el) || null,
    matchUploader: (name) => uploaderMatcher.match(name),
    testUploaderRule: (name) => {
      const r = uploaderMatcher.test(name);
      return r ? r.raw : null;
    },
  };
  try {
    Object.defineProperty(window, '__stormBlockerTestApi', { value: testApi, enumerable: false });
  } catch (err) {
    /* 极少数环境下 defineProperty 会被拦，忽略 */
  }
})();
