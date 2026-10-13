/*!
 * 风暴屏蔽器 — 共享屏蔽规则库
 *
 * 这个文件同时被两处加载：
 *   1. content script（普通 <script> 注入，挂在全局 window 上）
 *   2. 测试脚本（Node.js，通过 module.exports 取用）
 * 所以下面用 UMD 风格做一层导出，不依赖构建工具。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormBlock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'stormBlockConfig';

  /**
   * 默认名单：影视飓风本体 + 常见矩阵/团队账号。
   * 如果你要屏蔽的是别的账号，直接在 popup 里改名单即可。
   * 支持三种写法：
   *   - 普通文字：子串匹配（"影视飓风" 会命中 "影视飓风"、"影视飓风TV"…）
   *   - * 通配符：如 "飓风*"
   *   - /正则/：如 "/^影视飓风$/"
   *
   * TODO(可自行增删)：矩阵账号名字会变，这里只放比较稳的几个，
   * 你在推荐流里看到不想看的名字，复制进 popup 的名单即可。
   */
  const DEFAULT_BLOCKED_UPLOADERS = [
    '影视飓风',
    '亿点点不一样',
    '飓风无限',
    '时间胶囊',
    '风暴眼',
    'Hsunami',
    '飓多多',
    '十个面',
  ];

  const DEFAULT_CONFIG = {
    enabled: true,
    mode: 'hide', // 'hide' 完全移除 | 'dim' 淡化（保留占位，方便看清单）
    platforms: { bilibili: true, youtube: true },
    blockedUploaders: DEFAULT_BLOCKED_UPLOADERS.slice(),
    blockedTitles: [],
    showToast: true,
  };

  /* ------------------------------------------------------------------ *
   * 规则解析 / 匹配
   * ------------------------------------------------------------------ */

  /** 全角空格、零宽字符、连续空白统统归一化，避免"看着一样却不匹配"。 */
  function normalizeName(input) {
    if (input == null) return '';
    return String(input)
      .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(/[\s\u00a0\u3000]+/g, ' ')
      .trim();
  }

  /**
   * 站点渲染时常把附加信息拼进作者名里：
   *   "影视飓风 · 9月16日" / "影视飓风 · 共16课时" / "影视飓风 · 昨天"
   * 这里把分隔符之后的部分去掉，只留真正的名字。
   * 注意："麦克阿瑟·杰克逊" 这种名字里的间隔号不带空格，不会被误切。
   */
  const LABEL_SUFFIX_RE = /\s+[·•・‧|丨]\s*.*$/;

  function authorName(input) {
    const n = normalizeName(input);
    if (!n) return '';
    const cut = n.replace(LABEL_SUFFIX_RE, '').trim();
    return cut || n;
  }

  function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
  }

  /**
   * 把多行文本解析成规则数组。
   * @param {string|string[]} text
   * @returns {Array<{raw:string,type:'text'|'wildcard'|'regex',value:string|RegExp}>}
   */
  function parseRules(text) {
    const lines = Array.isArray(text) ? text : String(text == null ? '' : text).split(/\r?\n/);
    const rules = [];
    for (const line of lines) {
      // 允许 # 和 // 开头的注释行，方便在名单里做笔记
      const stripped = String(line).replace(/\s+#.*$/, '');
      const name = normalizeName(stripped);
      if (!name || name.startsWith('//') || name.startsWith('#')) continue;

      const asRegex = /^\/(.+)\/([gimsuy]*)$/.exec(name);
      if (asRegex) {
        try {
          rules.push({ raw: name, type: 'regex', value: new RegExp(asRegex[1], asRegex[2].replace('g', '')) });
        } catch (err) {
          // 正则写错了就当普通文字处理，别让整份名单失效
          rules.push({ raw: name, type: 'text', value: name.toLowerCase() });
        }
        continue;
      }

      if (name.includes('*')) {
        rules.push({ raw: name, type: 'wildcard', value: wildcardToRegExp(name) });
        continue;
      }

      rules.push({ raw: name, type: 'text', value: name.toLowerCase() });
    }
    return rules;
  }

  /** 单条规则是否命中给定名字。 */
  function ruleMatches(rule, name) {
    if (!rule || !name) return false;
    if (rule.type === 'regex') {
      rule.value.lastIndex = 0;
      return rule.value.test(name);
    }
    if (rule.type === 'wildcard') return rule.value.test(name);
    return name.toLowerCase().includes(rule.value);
  }

  /**
   * 编译一份匹配器。
   * @param {string|string[]} text 名单文本
   * @returns {{rules:Array, match:(name:string)=>boolean, test:(name:string)=>object|null}}
   */
  function buildMatcher(text) {
    const rules = parseRules(text);
    /** 规则匹配：原名和"去掉站点附加信息"的名字都试一遍。 */
    const hits = (rule, clean, stripped) =>
      ruleMatches(rule, clean) || (stripped !== clean && ruleMatches(rule, stripped));

    return {
      rules,
      isEmpty: rules.length === 0,
      match(name) {
        const clean = normalizeName(name);
        if (!clean) return false;
        const stripped = authorName(clean);
        for (const rule of rules) {
          if (hits(rule, clean, stripped)) return true;
        }
        return false;
      },
      /** 调试用：返回命中的那条规则。 */
      test(name) {
        const clean = normalizeName(name);
        if (!clean) return null;
        const stripped = authorName(clean);
        for (const rule of rules) {
          if (hits(rule, clean, stripped)) return rule;
        }
        return null;
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 配置归一化
   * ------------------------------------------------------------------ */

  /**
   * 把任意（可能来自旧版本、可能被手改坏的）配置补全成完整结构。
   * 永远返回一个新对象，调用方不必担心共享引用。
   */
  function normalizeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const toList = (v, fallback) => {
      if (Array.isArray(v)) return v.map(normalizeName).filter(Boolean);
      if (typeof v === 'string') return parseRules(v).map((r) => r.raw);
      return fallback.slice();
    };
    return {
      enabled: src.enabled !== false,
      mode: src.mode === 'dim' ? 'dim' : 'hide',
      platforms: {
        bilibili: !src.platforms || src.platforms.bilibili !== false,
        youtube: !src.platforms || src.platforms.youtube !== false,
      },
      blockedUploaders: toList(src.blockedUploaders, DEFAULT_BLOCKED_UPLOADERS),
      blockedTitles: toList(src.blockedTitles, []),
      showToast: src.showToast !== false,
    };
  }

  /** 名单数组 -> 可编辑的文本（popup textarea 用）。 */
  function listToText(list) {
    return (Array.isArray(list) ? list : []).join('\n');
  }

  function configToDraft(cfg) {
    const c = normalizeConfig(cfg);
    return {
      uploaderText: listToText(c.blockedUploaders),
      titleText: listToText(c.blockedTitles),
    };
  }

  return {
    STORAGE_KEY,
    DEFAULT_CONFIG,
    DEFAULT_BLOCKED_UPLOADERS,
    normalizeName,
    authorName,
    parseRules,
    ruleMatches,
    buildMatcher,
    normalizeConfig,
    listToText,
    configToDraft,
  };
});
