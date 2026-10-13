/*!
 * 迷你 DOM 桩 —— 单元测试专用
 *
 * 目的不是复刻浏览器，而是刚好够 content.js 的扫描逻辑跑起来：
 * 元素树、class 选择器、attributes、尺寸、可见性。
 * 任何 content.js 里新用到的 DOM 能力，都要在这里补一个实现。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const BLOCKLIST_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'blocklist.js'), 'utf8');

/**
 * 重要：El 必须挂在真实 globalThis 上做单例。
 * vm 沙箱默认没有 class 概念上的"共享"，如果 sandbox 里自带的 El 是另一份拷贝，
 * 测试里 new 出来的元素和脚本里遍历到的元素就不是同一个对象，
 * 断言会诡异地失败（属性设了却读不到）。真实浏览器里两边本来就共享同一个类。
 */
if (!globalThis.__sbElStub) globalThis.__sbElStub = makeElClass();
const El = globalThis.__sbElStub;

function makeElClass() {
  return class El {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = String(tag).toUpperCase();
    this._attrs = Object.assign({}, attrs);
    this._text = text;
    // 注意：这里必须用普通数组而不是 Set。
    // El 实例会跨 vm 沙箱边界使用，而宿主里的 Set 在沙箱里 has() 会直接抛错，
    // 导致选择器全部匹配不上（排查了很久的一个坑）。
    this._classes = [];
    this._style = { display: '', position: '' };
    this.children = [];
    this.parentElement = null;
    this.classList = {
      add: (...v) => v.forEach((c) => { if (!this._classes.includes(c)) this._classes.push(c); }),
      remove: (...v) => { this._classes = this._classes.filter((c) => !v.includes(c)); },
      contains: (c) => this._classes.includes(c),
    };
    if (attrs.class) {
      String(attrs.class)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => this._classes.push(c));
    }
  }

  set innerHTML(v) {
    this._text = String(v);
    this.children = [];
  }

  /** 测试便利：像 appendChild 一样"加了谁就返回谁" */
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return nodes.length === 1 ? nodes[0] : this;
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  get id() {
    return this._attrs.id || '';
  }

  get className() {
    return this._classes.join(' ');
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }

  setAttribute(name, value) {
    this._attrs[name] = String(value);
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }

  /** 测试里用 setRect 控制尺寸；默认给一个"卡片大小"的矩形 */
  setRect(width, height) {
    this._rect = { width, height };
    return this;
  }

  getBoundingClientRect() {
    const r = this._rect || { width: 320, height: 180 };
    return { width: r.width, height: r.height, top: 0, left: 0, right: r.width, bottom: r.height };
  }

  getComputedStyle() {
    return { display: this._style.display, position: this._style.position };
  }

  checkVisibility() {
    return this._style.display !== 'none';
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** 只判断"元素自身"是否命中（浏览器原生 matches() 也是这个语义） */
  matches(selector) {
    return matchesSelf(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  };
}

/** 只支持标签 / .class / #id / [attr*=v] 几种简单选择器（够用即可） */
function matchSimple(el, part) {
  if (!part) return false;

  // 复合选择器（a[href*=...]、.cls[attr=...]）拆成基础部分 + 属性部分
  const bracket = part.indexOf('[');
  if (bracket > 0) {
    return matchSimple(el, part.slice(0, bracket)) && matchSimple(el, part.slice(bracket));
  }

  if (part.startsWith('.')) return el._classes.includes(part.slice(1));  if (part.startsWith('#')) {
    // YouTube 用 <span id="text"> 存频道名，所以这里也模拟一个 #text 伪元素
    if (part === '#text') return el.id === 'text';
    return el.id === part.slice(1);
  }
  if (part.startsWith('[')) {
    const m = /^\[([\w-]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\]$/.exec(part);
    if (!m) return false;
    const value = el.getAttribute(m[1]);
    if (value == null) return false;
    if (!m[2]) return true;
    if (m[2] === '*') return String(value).includes(m[3]);
    if (m[2] === '^') return String(value).startsWith(m[3]);
    return String(value).endsWith(m[3]);
  }
  return el.tagName === part.toUpperCase();
}

/**
 * 按空白切分后代组合器，但别把 [href*="a b"] 里的空格切开。
 */
function splitDescendant(selector) {
  const steps = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const ch of selector) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) steps.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) steps.push(cur);
  return steps;
}

/**
 * 按逗号切分选择器列表，但别把 [href*="a,b"] 里的逗号切开。
 */
function splitSelectorList(selector) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const ch of selector) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 支持后代组合器（"ytd-channel-name #text" 这种），不支持 > + ~ */
function matchesSelector(el, selector) {
  return splitSelectorList(String(selector)).some((part) => {
    const steps = splitDescendant(part);
    if (!steps.length) return false;
    if (!matchSimple(el, steps[steps.length - 1])) return false;
    let node = el.parentElement;
    for (let i = steps.length - 2; i >= 0; i -= 1) {
      while (node && !matchSimple(node, steps[i])) node = node.parentElement;
      if (!node) return false;
      node = node.parentElement;
    }
    return true;
  });
}

/** 只判断元素自身（不往上找祖先） */
function matchesSelf(el, selector) {
  return splitSelectorList(String(selector)).some((part) => {
    const steps = splitDescendant(part);
    if (!steps.length) return false;
    // 自身匹配时不允许带后代组合器
    if (steps.length > 1) return false;
    return matchSimple(el, steps[0]);
  });
}

/** 造一个假的浏览器环境，把 lib/blocklist.js + content.js 真跑起来 */
function createEnv({ hostname = 'www.bilibili.com', href = 'https://www.bilibili.com/' } = {}) {
  const body = new El('body');
  const documentElement = new El('html');
  documentElement.append(body);

  const location = { hostname, href };
  const listeners = {};
  const windowObj = {};

  const document = {
    readyState: 'complete',
    body,
    documentElement,
    getElementById: (id) => body.querySelectorAll('#' + id)[0] || null,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    createElement: (tag) => new El(tag),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };

  const window = new Proxy(windowObj, {
    has: (target, prop) => prop in target,
    get(target, prop) {
      if (prop === 'document') return document;
      if (prop === 'location') return location;
      if (prop === 'setTimeout' || prop === 'setInterval') return () => 0;
      if (prop === 'clearTimeout' || prop === 'clearInterval') return () => {};
      if (prop === 'getComputedStyle') return (el) => el.getComputedStyle();
      if (prop === 'requestIdleCallback') return () => 0;
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });

  const sandbox = {
    window,
    document,
    location,
    // 沙箱里显式共享同一个 El 类，避免出现"两份类"的诡异问题
    El,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    // content.js 会优先用 requestIdleCallback；这里同步执行，
    // 测试就能"改完 DOM 立刻断言"，而不用等异步调度。
    requestIdleCallback: (fn) => {
      fn({ didTimeout: false, timeRemaining: () => 0 });
      return 0;
    },
    getComputedStyle: (el) => el.getComputedStyle(),
    queueMicrotask: (fn) => fn(),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener: (fn) => (listeners.message = fn) },
      },
      storage: {
        local: { get: (key, cb) => cb({}), set: () => {} },
        onChanged: { addListener: (fn) => (listeners.storage = fn) },
      },
      tabs: { query: () => {}, sendMessage: () => {} },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(BLOCKLIST_SRC, sandbox, { filename: 'lib/blocklist.js' });

  // vm 里 `globalThis` 就是 sandbox 本身，而浏览器里 globalThis === window。
  // 把脚本挂到全局的导出镜像回 windowObj，模拟浏览器行为。
  for (const key of Object.getOwnPropertyNames(sandbox)) {
    if (key === 'globalThis' || key === 'window') continue;
    windowObj[key] = sandbox[key];
  }

  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });

  return { window, document, body, api: windowObj.__stormBlockerTestApi, listeners };
}

/** 一张 B 站首页视频卡片 */
function biliCard(author, title = '某个视频') {
  const card = new El('div', { class: 'bili-video-card' });
  const info = new El('div', { class: 'bili-video-card__info' });
  info.append(new El('div', { class: 'bili-video-card__info--tit' }, title));
  info.append(new El('div', { class: 'bili-video-card__info--author' }, author));
  card.append(info);
  return card;
}

/**
 * 按真实 DOM 复刻的 B 站搜索页卡片（结构取自 search.bilibili.com 的真实 HTML）。
 * 关键点：__info--author 是只含名字的 span，
 * 上传日期是它后面的兄弟节点 __info--date（" · 9月16日"）。
 */
function biliSearchCard(author, title = '某个视频', date = ' · 9月16日') {
  const card = new El('div', { class: 'bili-video-card' });
  const skeleton = new El('div', { class: 'hide bili-video-card__skeleton' });
  skeleton.append(new El('div', { class: 'bili-video-card__skeleton--cover' }));
  card.append(skeleton);

  const wrap = new El('div', { class: 'bili-video-card__wrap' });
  const link = new El('a', { href: '//www.bilibili.com/video/BV1GGaZ6AEzJ/' });
  const image = new El('div', { class: 'bili-video-card__image' });
  image.append(new El('div', { class: 'bili-video-card__cover' }));
  link.append(image);
  const info = new El('div', { class: 'bili-video-card__info' });
  info.append(new El('h3', { class: 'bili-video-card__info--tit', title }, title));
  const bottom = new El('div', { class: 'bili-video-card__info--bottom' });
  const owner = new El('a', { class: 'bili-video-card__info--owner', href: '//space.bilibili.com/946974' });
  owner.append(new El('span', { class: 'bili-video-card__info--author' }, author));
  owner.append(new El('span', { class: 'bili-video-card__info--date' }, date));
  bottom.append(owner);
  info.append(bottom);
  link.append(info);
  wrap.append(link);
  card.append(wrap);
  return card;
}

/**
 * 按真实 DOM 复刻的 B 站搜索页"课程/活动推广横条"（结构取自真实 HTML）。
 * 它没有视频卡片结构，UP 主名字只出现在描述里：
 *   <div class="activity-card">
 *     <div class="activity-card__cover">…</div>
 *     <div class="activity-card-content">
 *       <div class="activity-card-content-head">
 *         <div class="...-title"><a title="…">标题</a></div>
 *         <div class="...-head-desc">影视飓风</div>
 *       </div>
 *       <a class="activity-card-content-footer"><button>查看详情</button></a>
 *     </div>
 *   </div>
 */
function biliActivityCard(owner, title = 'Tim带你从0入门剪辑') {
  const card = new El('div', { class: 'activity-card' });
  card.append(new El('div', { class: 'activity-card__cover' }));
  const content = new El('div', { class: 'activity-card-content' });
  const head = new El('div', { class: 'activity-card-content-head' });
  const titleBox = new El('div', { class: 'activity-card-content-head-title' });
  titleBox.append(new El('a', { title, href: 'https://www.bilibili.com/cheese/play/ss1' }, title));
  head.append(titleBox);
  head.append(new El('div', { class: 'activity-card-content-head-desc' }, owner));
  content.append(head);
  const footer = new El('a', { class: 'activity-card-content-footer' });
  footer.append(new El('button', { class: 'vui_button' }, '查看详情'));
  content.append(footer);
  card.append(content);
  return card;
}

/**
 * 按真实 DOM 复刻的 B 站搜索页"UP 主名片"。
 * 关键点：名片和它下面的视频网格是**同一个父容器里的兄弟节点**，
 * 所以只能隐藏名片本身，绝不能往上找到 .video-card-content 或更外层。
 *
 *   <div class="b-user-video-card">
 *     <div class="video-card-content">
 *       <div class="user-info">
 *         <a href="//space.bilibili.com/946974"><div class="search-user-avatar">…</div></a>
 *         <div class="user-content"><h2><a class="user-name">影视飓风</a></h2>…</div>
 *       </div>
 *     </div>
 *     <div class="user-video-info"><div class="video-list row">…视频卡片…</div></div>
 *   </div>
 */
function biliUserCardWithVideos(userName, videoAuthors = []) {
  const outer = new El('div', { class: 'b-user-video-card p_relative' });

  const content = new El('div', { class: 'video-card-content i_wrapper' });
  const info = new El('div', { class: 'user-info flex_start p_relative' });
  const infoCard = new El('div', { class: 'info-card flex_start' });
  const avatarLink = new El('a', { href: '//space.bilibili.com/946974' });
  const avatar = new El('div', { class: 'search-user-avatar p_relative' });
  avatar.append(new El('div', { class: 'avatar-wrap' }));
  avatarLink.append(avatar);
  infoCard.append(avatarLink);

  const userContent = new El('div', { class: 'user-content p_relative' });
  const h2 = new El('h2', { class: 'b_text i_card_title' });
  h2.append(new El('a', { class: 'user-name cs_pointer', href: '//space.bilibili.com/946974' }, userName));
  userContent.append(h2);
  userContent.append(new El('p', { class: 'user-video-desc' }, '1852.9万粉丝 · 932个视频'));
  infoCard.append(userContent);
  info.append(infoCard);
  content.append(info);
  outer.append(content);

  const videoInfo = new El('div', { class: 'user-video-info mt_md' });
  const list = new El('div', { class: 'video-list row' });
  for (const author of videoAuthors) {
    const item = new El('div', { class: 'video-list-item col_1_5' });
    item.append(biliSearchCard(author));
    list.append(item);
  }
  videoInfo.append(list);
  outer.append(videoInfo);

  return { outer, videoList: list, infoCardArea: content };
}

/** 一条 YouTube 首页视频卡片（频道名放在 <span id="text"> 里，跟真实 DOM 一致） */
function ytCard(channel, title = 'Some video') {
  const item = new El('ytd-rich-item-renderer');
  const grid = new El('ytd-rich-grid-media');
  const meta = new El('div', { class: 'ytd-video-meta-block' });
  const heading = new El('h3');
  heading.append(new El('span', {}, title));
  meta.append(heading);
  const channelName = new El('ytd-channel-name');
  channelName.append(new El('span', { id: 'text' }, channel));
  meta.append(channelName);
  grid.append(meta);
  item.append(grid);
  return item;
}

/**
 * 导航/守卫用的卡片容器：没有内容信息，所以 resolveCardTarget
 * 会穿过它继续往上找真卡片 —— 真实 YouTube 就是这样层层嵌套的。
 */
function ytCardShell() {
  return new El('ytd-rich-item-renderer');
}

module.exports = {
  El,
  createEnv,
  biliCard,
  biliSearchCard,
  biliActivityCard,
  biliUserCardWithVideos,
  ytCard,
  ytCardShell,
};
