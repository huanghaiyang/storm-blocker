/*!
 * 风暴屏蔽器 — 设置面板
 */
(function () {
  'use strict';

  const SB = window.StormBlock;
  const $ = (id) => document.getElementById(id);

  const els = {
    enabled: $('enabled'),
    mode: $('mode'),
    platBilibili: $('plat-bilibili'),
    platYoutube: $('plat-youtube'),
    showToast: $('showToast'),
    uploaders: $('uploaders'),
    titles: $('titles'),
    statCount: $('stat-count'),
    statTitle: $('stat-title'),
    statNames: $('stat-names'),
    saved: $('saved'),
    btnExport: $('btn-export'),
    btnImport: $('btn-import'),
    btnReset: $('btn-reset'),
  };

  let config = SB.normalizeConfig(null);
  let saveTimer = null;

  /* ---------------------------------------------------------------- *
   * 读写存储
   * ---------------------------------------------------------------- */

  function load(cb) {
    chrome.storage.local.get(SB.STORAGE_KEY, (data) => {
      config = SB.normalizeConfig(data && data[SB.STORAGE_KEY]);
      cb && cb();
    });
  }

  function persist() {
    // 把两个 textarea 的当前内容折算回配置
    config.blockedUploaders = SB.parseRules(els.uploaders.value).map((r) => r.raw);
    config.blockedTitles = SB.parseRules(els.titles.value).map((r) => r.raw);
    const payload = {};
    payload[SB.STORAGE_KEY] = config;
    chrome.storage.local.set(payload, () => flashSaved());
  }

  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, 320);
  }

  function flashSaved() {
    els.saved.classList.add('sb-show');
    setTimeout(() => els.saved.classList.remove('sb-show'), 1100);
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  function render() {
    els.enabled.checked = config.enabled;
    els.platBilibili.checked = config.platforms.bilibili;
    els.platYoutube.checked = config.platforms.youtube;
    els.showToast.checked = config.showToast;

    for (const btn of els.mode.querySelectorAll('button')) {
      btn.classList.toggle('sb-on', btn.dataset.mode === config.mode);
    }

    // 正在输入的框不要被覆盖，否则光标会跳
    if (document.activeElement !== els.uploaders) els.uploaders.value = SB.listToText(config.blockedUploaders);
    if (document.activeElement !== els.titles) els.titles.value = SB.listToText(config.blockedTitles);

    document.body.classList.toggle('sb-disabled', !config.enabled);
  }

  /* ---------------------------------------------------------------- *
   * 当前页面统计
   * ---------------------------------------------------------------- */

  function refreshStats() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
        els.statCount.textContent = '–';
        els.statTitle.textContent = '当前标签页不支持';
        els.statNames.textContent = '';
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'sb:getStats' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          els.statCount.textContent = '–';
          els.statTitle.textContent = '这个页面没跑脚本（B站/YouTube 页面才生效）';
          els.statNames.textContent = '';
          return;
        }
        els.statCount.textContent = String(res.count);
        const siteName = res.site === 'bilibili' ? 'B 站' : res.site === 'youtube' ? 'YouTube' : '未知站点';
        els.statTitle.textContent =
          res.count > 0 ? siteName + ' · 本页已拦下 ' + res.count + ' 个视频' : siteName + ' · 本页暂无命中';
        els.statNames.textContent = res.names && res.names.length ? '命中：' + res.names.join('、') : '';
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * 事件绑定
   * ---------------------------------------------------------------- */

  els.enabled.addEventListener('change', () => {
    config.enabled = els.enabled.checked;
    persist();
    document.body.classList.toggle('sb-disabled', !config.enabled);
  });

  els.mode.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    config.mode = btn.dataset.mode === 'dim' ? 'dim' : 'hide';
    render();
    persist();
  });

  els.platBilibili.addEventListener('change', () => {
    config.platforms.bilibili = els.platBilibili.checked;
    persist();
  });

  els.platYoutube.addEventListener('change', () => {
    config.platforms.youtube = els.platYoutube.checked;
    persist();
  });

  els.showToast.addEventListener('change', () => {
    config.showToast = els.showToast.checked;
    persist();
  });

  els.uploaders.addEventListener('input', saveSoon);
  els.titles.addEventListener('input', saveSoon);

  els.btnReset.addEventListener('click', () => {
    config = SB.normalizeConfig(SB.DEFAULT_CONFIG);
    render();
    persist();
  });

  els.btnExport.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'storm-blocker-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });

  els.btnImport.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          config = SB.normalizeConfig(JSON.parse(String(reader.result)));
        } catch (err) {
          els.statTitle.textContent = '导入失败：不是合法的配置文件';
          return;
        }
        render();
        persist();
      };
      reader.readAsText(file);
    });
    input.click();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SB.STORAGE_KEY]) return;
    config = SB.normalizeConfig(changes[SB.STORAGE_KEY].newValue);
    render();
  });

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */

  load(render);
  refreshStats();
  setInterval(refreshStats, 1500);
})();
