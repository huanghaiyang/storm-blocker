/*!
 * 风暴屏蔽器 — 自测
 *
 *   node --test tests/            （或直接 node tests/blocklist.test.js）
 *
 * 分三部分：
 *   1. lib/blocklist.js 的纯逻辑：名单解析、匹配、配置归一化
 *   2. content.js 的扫描主链路：用 tests/dom-stub.js 的迷你 DOM 把脚本真跑起来
 *   3. 扩展文件结构：manifest 引用、图标、popup 的 id 对得上
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SB = require(path.join(ROOT, 'lib', 'blocklist.js'));
const {
  El,
  createEnv,
  biliCard,
  biliSearchCard,
  biliActivityCard,
  biliUserCardWithVideos,
  ytCard,
  ytCardShell,
} = require('./dom-stub.js');

/* ==================================================================== *
 * 1. 纯逻辑
 * ==================================================================== */

test('名单解析：跳过空行/注释，保留规则原文', () => {
  const rules = SB.parseRules('影视飓风\n\n  \n// 这是注释\n# 也是注释\n飓风*\n/^Time.*Capsule$/');
  assert.deepEqual(
    rules.map((r) => [r.type, r.raw]),
    [
      ['text', '影视飓风'],
      ['wildcard', '飓风*'],
      ['regex', '/^Time.*Capsule$/'],
    ]
  );
});

test('匹配：子串命中、大小写不敏感、空白与零宽字符归一化', () => {
  const m = SB.buildMatcher('影视飓风\nHsunami');
  assert.equal(m.match('影视飓风'), true);
  assert.equal(m.match('影视飓风TV'), true, '子串应该命中');
  assert.equal(m.match('  影视飓风  '), true, '前后空格应该被忽略');
  assert.equal(m.match('影视\u200b飓风'), true, '零宽字符应该被忽略');
  assert.equal(m.match('影视 飓风'), false, '中间插了空格就不是同一个名字了');
  assert.equal(m.match('hsunami'), true, '拉丁字母大小写不敏感');
  assert.equal(m.match('HSUNAMI'), true);
  assert.equal(m.match('影视飓风番外'), true);
  assert.equal(m.match('木鱼水心'), false);
  assert.equal(m.match(''), false);
  assert.equal(m.match(null), false);
});

test('匹配：通配符与正则', () => {
  const m = SB.buildMatcher('飓风*\n/^Time.*$/i');
  assert.equal(m.match('飓风无限'), true);
  assert.equal(m.match('飓风工作室'), true);
  assert.equal(m.match('小飓风'), false, '通配符是按整串匹配，不是子串');
  assert.equal(m.match('TimeCapsule'), true);
  assert.equal(m.match('time machine'), true, '正则带 i');
  assert.equal(m.match('Machine Time'), false);
});

test('匹配：写坏的正则降级成普通文字，不会让整份名单失效', () => {
  const m = SB.buildMatcher('/[未闭合/\n影视飓风');
  assert.equal(m.match('/[未闭合/'), true, '坏正则按文字匹配');
  assert.equal(m.match('影视飓风'), true, '后面的规则依然生效');
});

test('匹配：行尾 # 注释被剥掉（方便在名单里写备注）', () => {
  assert.deepEqual(SB.parseRules('影视飓风 # 主号').map((r) => r.raw), ['影视飓风'], '注释不该留在规则里');
  const m = SB.buildMatcher('影视飓风 # 主号\n亿点点不一样');
  assert.equal(m.match('影视飓风'), true);
  assert.equal(m.match('亿点点不一样'), true);
});

test('配置归一化：坏数据被补全成完整结构', () => {
  const c = SB.normalizeConfig({ enabled: false, mode: '乱写', platforms: { youtube: false } });
  assert.equal(c.enabled, false);
  assert.equal(c.mode, 'hide', '非法 mode 回落到 hide');
  assert.equal(c.platforms.bilibili, true);
  assert.equal(c.platforms.youtube, false);
  assert.deepEqual(c.blockedUploaders, SB.DEFAULT_BLOCKED_UPLOADERS);
});

test('配置归一化：名单可以是数组也可以是文本', () => {
  const fromArray = SB.normalizeConfig({ blockedUploaders: ['影视飓风', '  ', 'Storm'] });
  assert.deepEqual(fromArray.blockedUploaders, ['影视飓风', 'Storm']);
  const fromText = SB.normalizeConfig({ blockedUploaders: '影视飓风\n// 备注\n飓风*' });
  assert.deepEqual(fromText.blockedUploaders, ['影视飓风', '飓风*']);
  assert.deepEqual(SB.normalizeConfig(null).blockedTitles, [], 'null 也要能兜住');
});

test('默认名单确实包含影视飓风及其矩阵账号，且没有重复项', () => {
  const list = SB.DEFAULT_BLOCKED_UPLOADERS;
  for (const name of ['影视飓风', '亿点点不一样', '飓风无限']) {
    assert.ok(list.includes(name), '默认名单缺少 ' + name);
  }
  assert.equal(new Set(list).size, list.length, '默认名单有重复');
  for (const name of list) assert.equal(name, SB.normalizeName(name), name + ' 没有归一化');
});

/* ==================================================================== *
 * 2. 扫描主链路
 * ==================================================================== */

test('B 站：命中名单的卡片被标记，没命中的原样保留', () => {
  const env = createEnv();
  const blocked = env.body.append(biliCard('影视飓风', '我们做了个新东西'));
  const alsoBlocked = env.body.append(biliCard('亿点点不一样', '闲鱼捡垃圾'));
  const fine = env.body.append(biliCard('木鱼水心', '一部好电影'));
  env.body.append(biliCard('影视飓风番外', '副号也算'));

  env.api.scan();

  assert.equal(blocked.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(alsoBlocked.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(fine.getAttribute('data-sb-hidden'), null, '不相干的 UP 主不该被动');
  assert.equal(env.api.getHiddenCount(), 3);
  const names = env.api.getMatchedNames();
  assert.deepStrictEqual(Array.prototype.slice.call(names).sort(), ['亿点点不一样', '影视飓风', '影视飓风番外']);
});

test('嵌套卡片只标记最外层，不重复计数', () => {
  const env = createEnv();
  const wrapper = env.body.append(new El('div', { class: 'feed-card' }));
  wrapper.append(biliCard('影视飓风'));

  env.api.scan();

  assert.equal(wrapper.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(env.api.getHiddenCount(), 1, '内层卡片应该被跳过');
});

test('切换成淡化模式后重新打标记', () => {
  const env = createEnv();
  const card = env.body.append(biliCard('影视飓风'));

  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), 'hide');

  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { mode: 'dim' }));
  assert.equal(card.getAttribute('data-sb-hidden'), 'dim');
});

test('关掉总开关后所有标记被还原，打开后重新命中', () => {
  const env = createEnv();
  const card = env.body.append(biliCard('影视飓风'));

  env.api.scan();
  assert.equal(env.api.getHiddenCount(), 1);

  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { enabled: false }));
  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), null, '关掉之后要还原');
  assert.equal(env.api.getHiddenCount(), 0);

  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { enabled: true }));
  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), 'hide');
});

test('单独关掉某个站点：在别的站点仍然生效', () => {
  const env = createEnv();
  const card = env.body.append(biliCard('影视飓风'));
  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { platforms: { bilibili: false, youtube: true } }));
  env.api.scan();
  assert.equal(env.api.getHiddenCount(), 0);
  assert.equal(card.getAttribute('data-sb-hidden'), null);
});

test('自定义名单：加一个自己的，删掉默认的', () => {
  const env = createEnv();
  const theirs = env.body.append(biliCard('某某营销号'));
  const storm = env.body.append(biliCard('影视飓风'));

  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { blockedUploaders: ['某某营销号'] }));
  env.api.scan();

  assert.equal(theirs.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(storm.getAttribute('data-sb-hidden'), null, '默认名单被替换掉了');
});

test('按标题关键词屏蔽', () => {
  const env = createEnv();
  const hit = env.body.append(biliCard('某个正常UP', '震惊！必看！'));
  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { blockedTitles: ['震惊'] }));
  env.api.scan();
  assert.equal(hit.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(env.api.getMatchedNames().length, 1);
  assert.match(env.api.getMatchedNames()[0], /^标题：/);
});

test('本来就不可见的卡片（折叠/未渲染）不参与计数', () => {
  const env = createEnv();
  const card = env.body.append(biliCard('影视飓风'));
  card._style.display = 'none';

  env.api.scan();

  assert.equal(card.getAttribute('data-sb-hidden'), null);
  assert.equal(env.api.getHiddenCount(), 0, '隐藏的卡片不该算进拦截数');
});

test('YouTube：整块卡片被隐藏，无关频道不受影响', () => {
  const env = createEnv({ hostname: 'www.youtube.com', href: 'https://www.youtube.com/' });
  const bad = env.body.append(ytCard('影视飓风'));
  const good = env.body.append(ytCard('Marques Brownlee'));

  env.api.scan();

  assert.equal(bad.getAttribute('data-sb-hidden'), 'hide', '应该隐藏 ytd-rich-item-renderer 整块');
  assert.equal(good.getAttribute('data-sb-hidden'), null);
});

test('YouTube：handle 里混着 @ 也能命中', () => {
  const env = createEnv({ hostname: 'www.youtube.com' });
  const card = env.body.append(ytCard('@Hsunami'));
  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), 'hide');
});

test('resolveCardTarget：节点本身不在卡片里时，从后代里找卡片归属', () => {
  const env = createEnv({ hostname: 'www.youtube.com' });
  const wrapper = env.body.append(new El('div', { class: 'page-wrapper' }));
  const item = wrapper.append(ytCard('影视飓风'));

  assert.equal(env.api.resolveCardTarget(wrapper), item);
});

test('未知卡片结构：靠尺寸启发式往上兜底', () => {
  const env = createEnv();
  // 全新的卡片 class（站点还没有的），作者名沿用已知 class —— 模拟"容器改版了但信息还在"
  const shell = env.body.append(new El('div', { class: 'brand-new-card-2027' }).setRect(360, 200));
  const authorBox = shell.append(new El('div', { class: 'tiny-author-box' }).setRect(200, 40));
  authorBox.append(new El('span', { class: 'up-name' }, '影视飓风'));

  env.api.scan();

  assert.equal(shell.getAttribute('data-sb-hidden'), 'hide', '靠尺寸兜底也应该认出来');
  assert.equal(env.api.getHiddenCount(), 1);
});

test('未知卡片结构：作者名 class 也换了，则靠已知卡片祖先兜底', () => {
  const env = createEnv({ hostname: 'www.youtube.com' });
  const shell = env.body.append(ytCardShell().setRect(360, 200));
  const inner = shell.append(new El('div', { class: 'brand-new-card-2027' }).setRect(350, 190));
  inner.append(new El('span', { class: 'some-new-author-class' }, '影视飓风'));

  assert.equal(env.api.resolveCardTarget(inner), shell, '应该认得出这是同一张卡');

  // 但取名字失败，就不该乱隐藏 —— 宁可漏杀不可错杀
  env.api.scan();
  assert.equal(shell.getAttribute('data-sb-hidden'), null);
  assert.equal(env.api.getHiddenCount(), 0);
});

test('页面脚本挂在非 B站/YouTube 域名时整体不动作', () => {
  const env = createEnv({ hostname: 'example.com', href: 'https://example.com/' });
  const card = env.body.append(biliCard('影视飓风'));
  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), null);
  assert.equal(env.api.site, null);
});

test('与 popup 的通信：stats 消息返回当前命中情况', () => {
  const env = createEnv();
  env.body.append(biliCard('影视飓风'));
  env.api.scan();

  let reply = null;
  env.listeners.message({ type: 'sb:getStats' }, {}, (payload) => (reply = payload));

  assert.ok(reply, '必须同步回包，否则 popup 拿不到统计');
  assert.equal(reply.site, 'bilibili');
  assert.equal(reply.count, 1);
  assert.deepStrictEqual(Array.prototype.slice.call(reply.names), ['影视飓风']);
});

/* ------------------------------------------------------------------ *
 * 3. B 站搜索页（按真实 DOM 结构复刻）
 * ------------------------------------------------------------------ */

test('搜索页：命中的卡片被隐藏，没命中的保留', () => {
  const env = createEnv({ hostname: 'search.bilibili.com', href: 'https://search.bilibili.com/all?keyword=x' });
  const storm = env.body.append(biliSearchCard('影视飓风', '动态视频｜拿到新手机0.01秒后……'));
  const other = env.body.append(biliSearchCard('翛鹤翷渊', '某人的视频'));
  const crew = env.body.append(biliSearchCard('飓多多StormCrew', '继续'));

  env.api.scan();

  assert.equal(storm.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(crew.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(other.getAttribute('data-sb-hidden'), null, '无关 UP 主不该被动');
  assert.equal(env.api.getHiddenCount(), 2);
});

test('搜索页：日期等附加信息拼在作者名里也能命中', () => {
  const m = SB.buildMatcher(SB.DEFAULT_BLOCKED_UPLOADERS);
  // 搜索页/课程卡片真实出现过的几种形态
  assert.equal(m.match('影视飓风 · 9月16日'), true);
  assert.equal(m.match('影视飓风 · 共16课时'), true);
  assert.equal(m.match('影视飓风 · 昨天'), true);
  assert.equal(m.match('飓多多StormCrew · 昨天'), true);
  assert.equal(m.match('翛鹤翷渊 · 13小时前'), false);
  // 名字里本来就带间隔号（没有空格）的，不能误伤
  assert.equal(SB.authorName('影视飓风 · 9月16日'), '影视飓风');
  assert.equal(SB.authorName('麦克阿瑟·杰克逊'), '麦克阿瑟·杰克逊');
  assert.equal(SB.authorName(' 影视飓风 '), '影视飓风');
});

test('懒渲染：先以骨架屏出现、名字后到的卡片，名字到了必须能拦下来', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const card = env.body.append(biliSearchCard('', '动态视频｜拿到新手机0.01秒后……'));

  // 第一轮：名字还没渲染出来
  env.api.scan();
  assert.equal(env.api.getHiddenCount(), 0);
  assert.equal(card.getAttribute('data-sb-hidden'), null);

  // 站点把作者名填进去了
  card.querySelectorAll('.bili-video-card__info--author')[0].textContent = '影视飓风';
  env.api.scan();

  assert.equal(card.getAttribute('data-sb-hidden'), 'hide', '不能被第一轮的 skip 缓存卡死');
  assert.equal(env.api.getHiddenCount(), 1);
});

test('懒渲染：标题也是后到的，同样不能被缓存卡死', () => {
  const env = createEnv();
  const card = env.body.append(biliSearchCard('', ''));
  env.api.applyConfig(Object.assign({}, SB.DEFAULT_CONFIG, { blockedTitles: ['震惊'] }));
  env.api.scan();
  assert.equal(env.api.getHiddenCount(), 0);

  card.querySelectorAll('.bili-video-card__info--tit')[0].textContent = '震惊！这个必须有';
  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), 'hide');
});

test('读到了名字但确实不该拦：结果可以缓存，避免反复计算', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const other = env.body.append(biliSearchCard('翛鹤翷渊'));

  env.api.scan();
  assert.equal(other.getAttribute('data-sb-hidden'), null);

  // 缓存生效的证据：把名字改成命中项后，不再重扫的话不会被标记
  other.querySelectorAll('.bili-video-card__info--author')[0].textContent = '影视飓风';
  const countBefore = env.api.getHiddenCount();
  assert.equal(countBefore, 0);
});

test('作者名 class 全换了：靠卡片里的 UP 主主页链接兜底', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const card = env.body.append(biliSearchCard('影视飓风'));
  // 把名字 span 整个换成一个没见过的 class
  const authorSpan = card.querySelectorAll('.bili-video-card__info--author')[0];
  authorSpan._classes = ['totally-new-author-class-2099'];
  // 名字虽在，但和日期拼在一起 —— 兜底读取时要能切掉日期
  card.querySelectorAll('.bili-video-card__info--date')[0].textContent = ' · 9月16日';

  assert.equal(env.api.firstText(card, ['.bili-video-card__info--author']), '', '确认名字 class 已经失效');

  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), 'hide', 'space.bilibili.com 链接应该兜住');
});

test('兜底链接里只有日期时，不能误当成作者名', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const card = env.body.append(biliSearchCard('影视飓风'));
  const authorSpan = card.querySelectorAll('.bili-video-card__info--author')[0];
  authorSpan._classes = ['totally-new-author-class-2099'];
  authorSpan.textContent = ''; // 名字还没渲染
  card.querySelectorAll('.bili-video-card__info--date')[0].textContent = ' · 9月16日';

  env.api.scan();
  assert.equal(card.getAttribute('data-sb-hidden'), null, '只有日期不该触发拦截');
  assert.equal(env.api.getCardState(card), null, '更不该把卡片标记成"已检查过"');
});

test('搜索页：课程/活动推广横条也要拦（它没有视频卡片结构）', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const promo = env.body.append(biliActivityCard('影视飓风', 'Tim带你从0入门剪辑，剪出和影视飓风一样的视频'));
  const otherPromo = env.body.append(biliActivityCard('某个别的机构', '别的课程'));

  env.api.scan();

  assert.equal(promo.getAttribute('data-sb-hidden'), 'hide', '课程横条的 owner 在 head-desc 里');
  assert.equal(otherPromo.getAttribute('data-sb-hidden'), null);
});

test('搜索页：UP 主名片要拦，但绝不能连带它下面的视频网格', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  // 名片和视频网格是兄弟节点，共用同一个 .b-user-video-card 父容器
  const { outer, videoList } = biliUserCardWithVideos('影视飓风', ['翛鹤翷渊', '波波视频V']);
  env.body.append(outer);

  env.api.scan();

  assert.equal(outer.getAttribute('data-sb-hidden'), 'hide', '名片整块应该被隐藏');
  assert.equal(videoList.getAttribute('data-sb-hidden'), null, '视频网格不能被一起干掉');
  assert.equal(env.api.getHiddenCount(), 1);
});

test('搜索页：名片夹在视频网格里时，只隐藏名片那一小块', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const { outer, infoCardArea, videoList } = biliUserCardWithVideos('影视飓风', ['翛鹤翷渊']);
  env.body.append(outer);

  env.api.scan();

  // 被标记的必须是 b-user-video-card，而不是它的父级或视频列表
  assert.equal(outer.getAttribute('data-sb-hidden'), 'hide');
  assert.equal(infoCardArea.getAttribute('data-sb-hidden'), null, '名片的父容器不该被连带');
  assert.equal(videoList.getAttribute('data-sb-hidden'), null);
  assert.equal(env.api.getHiddenCount(), 1, '不能把网格里的视频重复计数');
});

test('搜索页：无关 UP 主的名片不该被隐藏', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const { outer } = biliUserCardWithVideos('翛鹤翷渊', []);
  env.body.append(outer);

  env.api.scan();

  assert.equal(outer.getAttribute('data-sb-hidden'), null);
  assert.equal(env.api.getHiddenCount(), 0);
});

test('整页混合场景：课程横条 + 名片 + 视频网格', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const promo = env.body.append(biliActivityCard('影视飓风'));
  const { outer, videoList } = biliUserCardWithVideos('影视飓风', ['影视飓风', '翛鹤翷渊', '飓多多StormCrew']);
  env.body.append(outer);

  env.api.scan();

  assert.equal(promo.getAttribute('data-sb-hidden'), 'hide', '课程横条');
  assert.equal(outer.getAttribute('data-sb-hidden'), 'hide', 'UP 主名片');
  assert.equal(videoList.getAttribute('data-sb-hidden'), null, '视频网格不该再单独打标记');

  // 统计口径：只算真正被打了隐藏标记的块。
  // 名片已经把整块裹住了，里面的网格视频不再重复计数（否则统计会虚高）。
  assert.equal(env.api.getHiddenCount(), 2, '课程横条 + 名片');

  // 但里面命中的作者名要如实记下来，popup 里能看到
  const names = Array.prototype.slice.call(env.api.getMatchedNames());
  assert.ok(names.includes('影视飓风'), '命中的作者名要记录');
});

test('整页复现：课程横条 + UP 主名片 + 8 条网格视频', () => {
  const env = createEnv({ hostname: 'search.bilibili.com', href: 'https://search.bilibili.com/all?keyword=x' });

  // 顶部课程推广（真实页面第一条）
  const promo = env.body.append(biliActivityCard('影视飓风', 'Tim带你从0入门剪辑，剪出和影视飓风一样的视频'));

  // UP 主名片 + 它下面的视频网格（真实页面：8 条，其中 1 条作者名还没渲染出来）
  const authors = ['影视飓风', '影视飓风', '飓多多StormCrew', '影视飓风', '', '影视飓风', '翛鹤翷渊', '影视飓风'];
  const { outer, videoList } = biliUserCardWithVideos('影视飓风', authors);
  env.body.append(outer);

  env.api.scan();

  assert.equal(promo.getAttribute('data-sb-hidden'), 'hide', '课程推广横条');
  assert.equal(outer.getAttribute('data-sb-hidden'), 'hide', 'UP 主名片');

  // 名片已经把整块裹住了，所以网格视频不需要各自打标记；但名字一个都不能漏判
  const gridCards = videoList.querySelectorAll('.bili-video-card');
  assert.equal(gridCards.length, authors.length, '网格里应该有 8 张卡片');
  const states = gridCards.map((c) => env.api.getCardState(c));
  for (let i = 0; i < authors.length; i += 1) {
    if (!authors[i]) continue; // 名字还没渲染的，这一轮不下结论，留给下一轮
    const expectHit = authors[i].includes('影视飓风') || authors[i].includes('飓多多');
    assert.equal(states[i], expectHit ? 'hit' : 'skip', '第 ' + (i + 1) + ' 张卡片判定不对');
  }
});

test('整页复现：名字渲染晚一步时，重扫一轮必须补上', () => {
  const env = createEnv({ hostname: 'search.bilibili.com' });
  const { outer, videoList } = biliUserCardWithVideos('影视飓风', ['影视飓风', '']);
  env.body.append(outer);
  env.api.scan();

  // 第二张卡片的作者名这时才渲染出来
  const lateCard = videoList.querySelectorAll('.bili-video-card')[1];
  lateCard.querySelectorAll('.bili-video-card__info--author')[0].textContent = '飓多多StormCrew';
  env.api.scan();

  assert.equal(env.api.getCardState(lateCard), 'hit', '晚渲染的卡片必须在下一轮被补上');
});

/* ------------------------------------------------------------------ *
 * 4. 扩展文件结构
 * ------------------------------------------------------------------ */

test('manifest.json 合法，且引用的文件都真实存在', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('storage'));

  const referenced = [
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts[0].js,
    ...manifest.content_scripts[0].css,
  ];
  assert.ok(manifest.content_scripts[0].matches.some((m) => m.includes('bilibili.com')));
  assert.ok(manifest.content_scripts[0].matches.some((m) => m.includes('youtube.com')));

  for (const rel of referenced) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), '清单引用了不存在的文件：' + rel);
  }

  // 内容脚本里用到的 lib 必须排在 content.js 前面
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf('lib/blocklist.js') < js.indexOf('content.js'));
  assert.equal(manifest.default_locale, undefined, '没有 _locales 目录时不能写 default_locale');
});

test('PNG 图标是真实的 PNG，尺寸对得上', () => {
  for (const size of [16, 32, 48, 128]) {
    const buf = fs.readFileSync(path.join(ROOT, 'icons', 'icon' + size + '.png'));
    assert.deepEqual(
      Array.from(buf.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'icon' + size + '.png 不是 PNG'
    );
    assert.equal(buf.readUInt32BE(16), size, 'icon' + size + ' 宽度不对');
    assert.equal(buf.readUInt32BE(20), size, 'icon' + size + ' 高度不对');
  }
});

test('popup.html 里的元素 id 和 popup.js 用到的完全对得上', () => {
  const html = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');

  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));
  const used = new Set(Array.from(js.matchAll(/\$\('([^']+)'\)/g)).map((m) => m[1]));

  for (const id of used) {
    assert.ok(ids.has(id), 'popup.js 找的 #' + id + ' 在 HTML 里不存在');
  }
  for (const id of ['enabled', 'mode', 'uploaders', 'titles']) {
    assert.ok(ids.has(id), 'HTML 缺少必需的 #' + id);
  }
  assert.ok(html.includes('../lib/blocklist.js'), 'popup 必须加载共享规则库');
});

test('content.css 覆盖了 hide / dim / 关闭三种状态', () => {
  const css = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');
  assert.match(css, /\[data-sb-hidden='hide'\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(css, /\[data-sb-hidden='dim'\]\s*\{[^}]*opacity/);
  assert.match(css, /html\[data-sb-off\]\s*\[data-sb-hidden\]/);
});

/* ------------------------------------------------------------------ *
 * 5. 选择器与线上真实结构的一致性
 * ------------------------------------------------------------------ */

/**
 * 这张表是"扩展真正使用的选择器 ↔ 线上真实页面"的对照。
 * 快照来自真实抓取的页面 HTML（见 tests/fixtures/）。
 * 它只列扩展用到的选择器；B 站改版后重新抓一份快照，这里会立刻红给你看。
 */
const SELECTOR_PAGE_MAP = [
  [
    'bilibili-search',
    [
      '.bili-video-card',
      '.bili-video-card__info--author',
      '.bili-video-card__info--tit',
      '.activity-card',
      '.activity-card-content-head-desc',
      '.b-user-video-card',
      '.user-name',
    ],
  ],
];

test('扩展的选择器都还在真实页面快照里（防止线上改版导致静默失效）', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  for (const [page, selectors] of SELECTOR_PAGE_MAP) {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', page + '-classes.json'), 'utf8')
    );
    const realClasses = new Set(fixture.classes);

    for (const selector of selectors) {
      assert.ok(
        realClasses.has(selector.slice(1)),
        page + ' 快照里已经没有 ' + selector + ' 了（线上结构可能变了）'
      );
      assert.ok(
        contentSrc.includes("'" + selector + "'"),
        '真实的 ' + selector + ' 没有被扩展使用，说明代码和线上结构脱节了'
      );
    }
  }
});

test('搜索页特有的两类非视频卡片确实被接管了', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  // 卡片容器
  assert.ok(contentSrc.includes("'.activity-card'"), 'CARD_SELECTORS 必须包含 .activity-card');
  assert.ok(contentSrc.includes("'.b-user-video-card'"), 'CARD_SELECTORS 必须包含 .b-user-video-card');
  // 从这两类卡片里读名字的入口
  assert.ok(
    contentSrc.includes("'.activity-card-content-head-desc'"),
    'AUTHOR_SELECTORS 必须能从课程横条里读出 UP 主名字'
  );
  assert.ok(contentSrc.includes("'.user-name'"), 'AUTHOR_SELECTORS 必须能从 UP 主名片里读出名字');
});
