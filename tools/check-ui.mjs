#!/usr/bin/env node
/**
 * WMC 面板 · 自检脚本（零依赖，node 直接跑）
 * ---------------------------------------------------------------------------
 *   node tools/check-ui.mjs            # 静态一致性 + 纯逻辑单测
 *   node tools/check-ui.mjs --verbose  # 打印每一项
 *
 * 检查内容：
 *   A. 脚本可加载（等价于语法检查）与纯函数单测（分页、筛选、格式化、内存/Java 判定）
 *   B. CSS 模块化约束：每个选择器必须以 .wmc- 开头；不允许出现裸标签选择器
 *   C. HTML ↔ CSS 一致性：用到但未定义的类名 = 错误；定义但未使用 = 提示
 *   D. HTML ↔ JS 一致性：JS 里用到的 data-wmc-* 挂载点必须在 HTML 中存在
 *   E. 两个面板片段与 index.html 的类名集合必须一致（防止两份拷贝漂移）
 *   F. 硬性规范：不得出现 <select> / input[type=range] 等系统原生控件；
 *      字体链必须包含宋体兜底
 *   G. CSS 变量：var(--x) 必须在 tokens 里定义
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/* ============================================================ 迷你测试框架 */

const results = [];
const queued = [];
let currentGroup = '通用';

function group(name) { currentGroup = name; }

/**
 * 登记一个用例。
 *
 * ⚠️ 注意：这里**只登记不执行**，全部用例在文件末尾统一 await 运行。
 * 之前的写法是「调用即执行」，但异步用例的 Promise 不会被 await，
 * 一旦内部抛错就变成了「空过」——这是自检工具本身最危险的 bug，故改成队列模型。
 */
function test(name, fn) {
  queued.push({ group: currentGroup, name, fn });
}

/** 依次执行已登记的用例（支持 async） */
async function runAll() {
  for (const item of queued) {
    const started = Date.now();
    try {
      const detail = await item.fn();
      results.push({ group: item.group, name: item.name, ok: true, ms: Date.now() - started, detail });
    } catch (error) {
      results.push({
        group: item.group, name: item.name, ok: false, ms: Date.now() - started,
        detail: error?.message || String(error),
      });
    }
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ============================================================ 文件清单 */

const CSS_FILES = [
  'styles/wmc-tokens.css',
  'styles/wmc-primitives.css',
  'styles/wmc-shell.css',
  'styles/wmc-home.css',
  'styles/wmc-game-download.css',
  'styles/wmc-dragdrop.css',
  'styles/wmc-download-center.css',
  'styles/wmc-runtime-panel.css',
  'styles/preview.css',
];
const PANEL_CSS_FILES = CSS_FILES.filter((f) => !f.endsWith('preview.css'));
const HTML_FILES = [
  'index.html',
  'app.html',
  'panels/download-center.html',
  'panels/runtime-panel.html',
  'panels/shell-nav.html',
  'panels/home-dashboard.html',
  'panels/game-download.html',
];
const PAGE_FILES = ['index.html', 'app.html'];
const JS_FILES = [
  'scripts/wmc-dom.js',
  'scripts/wmc-mock-data.js',
  'scripts/wmc-bridge.js',
  'scripts/wmc-custom-select.js',
  'scripts/wmc-toast.js',
  'scripts/wmc-shell.js',
  'scripts/wmc-home.js',
  'scripts/wmc-game-download.js',
  'scripts/wmc-dragdrop.js',
  'scripts/wmc-download-center.js',
  'scripts/wmc-runtime-panel.js',
  'scripts/app.js',
  'scripts/app-shell.js',
];

/* ============================================================ CSS 解析 */

/** 去掉注释 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 去掉 HTML 注释（否则「不要用 <select>」这类说明文字会被误判） */
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** 去掉 JS 注释（行注释 + 块注释），字符串里的 // 不在检查场景内，可接受 */
const stripJsComments = (js) => js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

/** 合法类名（模板字符串里的 ${...} 片段会被这条规则挡掉） */
const CLASS_RE = /^[A-Za-z_][\w-]*$/;

/**
 * 轻量 CSS 分块解析：返回所有「声明块」的 { selector, ancestry }。
 * 用于实现「选择器必须以 .wmc- 开头」这类模块化约束。
 */
function parseBlocks(css) {
  const src = stripComments(css);
  const blocks = [];
  const stack = [];
  let buffer = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = buffer.trim();
      const parent = stack[stack.length - 1] || null;
      const ancestry = parent ? [...parent.ancestry, parent.prelude] : [];
      const node = { prelude, ancestry, hasDeclarations: false, depth: stack.length };
      stack.push(node);
      blocks.push(node);
      buffer = '';
    } else if (ch === '}') {
      stack.pop();
      buffer = '';
    } else if (ch === ';') {
      if (stack.length && buffer.includes(':')) stack[stack.length - 1].hasDeclarations = true;
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return blocks;
}

/** 收集 CSS 里定义的全部类名 */
function collectCssClasses(files) {
  const set = new Set();
  for (const file of files) {
    const css = stripComments(read(file));
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) set.add(m[1]);
  }
  return set;
}

/** 收集 CSS 里定义的变量与使用的变量 */
function collectCssVariables(files) {
  const defined = new Set();
  const used = new Set();
  for (const file of files) {
    const css = stripComments(read(file));
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]);
  }
  return { defined, used };
}

/* ============================================================ HTML 解析 */

/** 收集 HTML 里的 class 名（含 class="a b" 与 class='a b'） */
function collectHtmlClasses(files) {
  const set = new Set();
  for (const file of files) {
    const html = read(file);
    for (const m of html.matchAll(/class\s*=\s*["']([^"']+)["']/g)) {
      for (const cls of m[1].trim().split(/\s+/)) if (cls) set.add(cls);
    }
  }
  return set;
}

/** 收集 HTML 里的 data-wmc-* 属性名 */
function collectHtmlHooks(files) {
  const set = new Set();
  for (const file of files) {
    const html = read(file);
    for (const m of html.matchAll(/(data-wmc-[\w-]+)/g)) set.add(m[1]);
  }
  return set;
}

/* ============================================================ 主体 */

group('A. 脚本加载与纯逻辑');

const dom = await import(pathToFileURL(join(ROOT, 'scripts/wmc-dom.js')).href);
const mockData = await import(pathToFileURL(join(ROOT, 'scripts/wmc-mock-data.js')).href);
const bridgeMod = await import(pathToFileURL(join(ROOT, 'scripts/wmc-bridge.js')).href);
const dcMod = await import(pathToFileURL(join(ROOT, 'scripts/wmc-download-center.js')).href);
const envMod = await import(pathToFileURL(join(ROOT, 'scripts/wmc-runtime-panel.js')).href);
const shellMod = await import(pathToFileURL(join(ROOT, 'scripts/wmc-shell.js')).href);
const homeMod = await import(pathToFileURL(join(ROOT, 'scripts/wmc-home.js')).href);

// 其余脚本只做「能否被解析/加载」的检查。
// 页面引导脚本（app.js / app-shell.js）在顶层就会访问 DOM，无法在 Node 里 import，
// 因此对它们改用 `node --check`（语法解析，不执行）。
const BOOTSTRAP_FILES = ['scripts/app.js', 'scripts/app-shell.js'];

for (const file of JS_FILES.filter((f) => !BOOTSTRAP_FILES.includes(f))) {
  test(`可加载 ${file}`, async () => {
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    assert(mod && typeof mod === 'object', '模块没有导出对象');
  });
}

for (const file of BOOTSTRAP_FILES) {
  test(`语法可解析 ${file}`, () => {
    const tmp = join(os.tmpdir(), `wmc-check-${file.replace(/\W/g, '_')}.mjs`);
    writeFileSync(tmp, read(file), 'utf8');
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    unlinkSync(tmp);
  });
}

test('formatCount 中文单位', () => {
  eq(dom.formatCount(999), '999', '千位以下原样');
  eq(dom.formatCount(12345), '1.2 万', '万位');
  eq(dom.formatCount(123456789), '1.2 亿', '亿位');
});

test('formatBytes 体积格式化', () => {
  eq(dom.formatBytes(500), '500 B', '字节');
  eq(dom.formatBytes(1024), '1.0 KB', 'KB');
  eq(dom.formatBytes(1048576), '1.0 MB', 'MB');
  eq(dom.formatBytes(3 * 1024 ** 3), '3.0 GB', 'GB');
});

test('middleEllipsis 路径中间省略', () => {
  eq(dom.middleEllipsis('C:\\a\\b', 20), 'C:\\a\\b', '短路径不变');
  const long = 'C:\\Users\\Public\\Documents\\WMC\\.minecraft\\versions\\1.21.4';
  const cut = dom.middleEllipsis(long, 30);
  assert(cut.includes('…'), '应包含省略号');
  eq(cut.length, 30, '长度应等于上限');
});

test('hashString 稳定且区分度足够', () => {
  eq(dom.hashString('模组A'), dom.hashString('模组A'), '同输入同结果');
  assert(dom.hashString('模组A') !== dom.hashString('模组B'), '不同输入应不同');
});

test('clamp / debounce 可用', () => {
  eq(dom.clamp(5, 1, 3), 3, '上限');
  eq(dom.clamp(-1, 1, 3), 1, '下限');
  const d = dom.debounce(() => {}, 10);
  assert(typeof d.cancel === 'function', 'debounce 应带 cancel');
});

test('mockSearch 分页不重叠且确定性', () => {
  const p1a = mockData.mockSearch({ category: 'mod', page: 1, pageSize: 10 });
  const p1b = mockData.mockSearch({ category: 'mod', page: 1, pageSize: 10 });
  eq(p1a.items.length, 10, '每页 10 条');
  eq(p1a.items[0].id, p1b.items[0].id, '两次请求结果一致（确定性）');
  const p2 = mockData.mockSearch({ category: 'mod', page: 2, pageSize: 10 });
  const ids1 = new Set(p1a.items.map((i) => i.id));
  const overlap = p2.items.filter((i) => ids1.has(i.id));
  eq(overlap.length, 0, '第二页不应与第一页重复');
  assert(p1a.hasMore === true, '第一页应提示还有更多');
});

test('mockSearch 支持来源筛选 / 搜索 / 排序', () => {
  const bySource = mockData.mockSearch({ category: 'mod', source: 'modrinth', pageSize: 100 });
  assert(bySource.items.length > 0, '应能筛出 Modrinth 资源');
  assert(bySource.items.every((i) => i.sourceId === 'modrinth'), '来源筛选必须严格生效');

  const byQuery = mockData.mockSearch({ category: 'mod', query: '匠魂', pageSize: 100 });
  assert(byQuery.items.length > 0, '关键字应命中');
  assert(byQuery.items.every((i) => `${i.title}${i.author}${(i.tags || []).join('')}`.includes('匠魂')),
    '结果应全部匹配关键字');

  const popular = mockData.mockSearch({ category: 'mod', sort: 'popular', pageSize: 10 });
  for (let i = 1; i < popular.items.length; i += 1) {
    assert(popular.items[i - 1].downloads >= popular.items[i].downloads, '热度排序应为降序');
  }
  const recent = mockData.mockSearch({ category: 'mod', sort: 'recent', pageSize: 10 });
  for (let i = 1; i < recent.items.length; i += 1) {
    assert(recent.items[i - 1].updatedAt >= recent.items[i].updatedAt, '更新时间应为降序');
  }
});

test('mockCategories 数量与数据集一致', () => {
  const cats = mockData.mockCategories();
  assert(cats.length === 8, `应有 8 个分类，实际 ${cats.length}`);
  const expectVanilla = mockData.mockSearch({ category: 'vanilla', pageSize: 999 }).total;
  eq(cats.find((c) => c.id === 'vanilla').count, expectVanilla, '原版数量应一致');
  for (const cat of cats) {
    assert(cat.name && cat.icon, `${cat.id} 应有名称与图标`);
  }
});

test('makeCover 生成内联 SVG 且确定性', () => {
  const a = mockData.makeCover('匠魂工艺', 'mod', 1);
  const b = mockData.makeCover('匠魂工艺', 'mod', 1);
  eq(a, b, '同样输入应生成同样封面');
  assert(a.startsWith('data:image/svg+xml,'), '应是 data-URI');
  const decoded = decodeURIComponent(a);
  assert(decoded.includes('<svg'), '解出后应是 SVG');
  // 关键回归：属性之间必须有空白，否则 <img> 解码失败 → 所有封面回退兜底图
  const glued = decoded.match(/"[A-Za-z-]+=/g);
  assert(!glued, `SVG 属性被粘在一起（会被浏览器判定为非法 XML）：${glued?.slice(0, 3).join(' ')}`);
  assert((decoded.match(/</g) || []).length === (decoded.match(/>/g) || []).length, '尖括号应成对');
});

test('recommendMemoryMb / hardMaxMb 边界', () => {
  eq(envMod.recommendMemoryMb(4096), 1024, '4GB 机器推荐 1GB');
  eq(envMod.recommendMemoryMb(16384), 4096, '16GB 机器推荐 4GB');
  eq(envMod.hardMaxMb(8192), 6144, '安全上限 = 物理内存 - 2GB');
  // 属性检查：任何物理内存下推荐值都必须合法且不超上限
  for (const total of [2048, 4096, 6144, 8192, 12288, 16384, 32768, 65536]) {
    const rec = envMod.recommendMemoryMb(total);
    assert(rec >= 1024, `${total}MB 推荐值不应小于 1GB`);
    assert(rec <= envMod.hardMaxMb(total), `${total}MB 推荐值不应超过安全上限`);
    eq(rec % 512, 0, '推荐值应为 512 的整数倍');
  }
});

test('memoryAdvice 三种状态', () => {
  eq(envMod.memoryAdvice(512, 16384, 8000).level, 'warn', '过小 → 红');
  eq(envMod.memoryAdvice(99999, 16384, 8000).level, 'warn', '超上限 → 红');
  eq(envMod.memoryAdvice(6144, 16384, 4096).level, 'gold', '可用内存不足 → 金');
  eq(envMod.memoryAdvice(4096, 16384, 9000).level, 'ok', '正常 → 绿');
});

test('javaAdvice 三种状态', () => {
  eq(envMod.javaAdvice(null, []).level, 'warn', '没有 Java → 红');
  eq(envMod.javaAdvice({ ok: false }, [{ ok: false }]).level, 'warn', '版本不适用 → 红');
  eq(envMod.javaAdvice(null, [{ ok: true }]).level, 'gold', '未指定 → 金');
  eq(envMod.javaAdvice({ ok: true, vendor: 'Adoptium', version: '21.0.8' }, [{ ok: true }]).level, 'ok', '正常 → 绿');
});

test('bridge 在无 IPC 时降级到 mock 且接口齐全', async () => {
  const bridge = bridgeMod.createBridge({ forceMock: true, onWarn: () => {} });
  eq(bridge.mode, 'mock', '无 window.wmc 时应为 mock');

  const cats = await bridge.categories();
  assert(Array.isArray(cats) && cats.length === 8, 'categories 应返回 8 项');
  const sources = await bridge.sources();
  assert(sources.length >= 4, 'sources 至少 4 项');
  const sys = await bridge.systemInfo();
  assert(sys.totalMemMb > 0, 'systemInfo 应有物理内存');
  const cfg = await bridge.configGet();
  assert(cfg && typeof cfg.maxMemoryMb === 'number', 'configGet 应返回配置');
  const patched = await bridge.configPatch({ maxMemoryMb: 2048 });
  eq(patched.maxMemoryMb, 2048, 'configPatch 应回显修改');
  const java = await bridge.javaList(false);
  assert(java.length >= 1, 'javaList 应有条目');
  const page = await bridge.search({ category: 'modpack', page: 1, pageSize: 6 });
  eq(page.items.length, 6, 'search 应遵守 pageSize');
  const latency = await bridge.testSources();
  assert(latency.every((l) => typeof l.latencyMs === 'number'), '测速结果应带延迟');

  // 下载进度事件：mock 会按 tick 推进
  const progress = await new Promise((resolve) => {
    let seen = 0;
    const off = bridge.onProgress((p) => { if (p && p.progress >= 0) seen += 1; });
    bridge.startDownload({ id: 'x1', title: '测试资源', sizeBytes: 10_000_000 });
    setTimeout(() => { off(); resolve(seen); }, 1400);
  });
  assert(progress >= 1, `应至少收到 1 次下载进度，实际 ${progress}`);
});

group('B. CSS 模块化约束');

test('每个 CSS 文件都声明了 @layer（避免全局污染）', () => {
  for (const file of CSS_FILES) {
    assert(read(file).includes('@layer'), `${file} 缺少 @layer`);
  }
});

test('选择器一律以 .wmc- 开头（预览页样式除外）', () => {
  const offenders = [];
  for (const file of PANEL_CSS_FILES) {
    for (const block of parseBlocks(read(file))) {
      if (!block.hasDeclarations) continue;
      // 跳过 @keyframes 内部的百分比帧
      if (block.ancestry.some((a) => a.startsWith('@keyframes'))) continue;
      if (block.prelude.startsWith('@')) continue;
      for (const selector of block.prelude.split(',')) {
        const sel = selector.trim();
        if (!sel) continue;
        if (!sel.startsWith('.wmc-')) offenders.push(`${file} → ${sel}`);
      }
    }
  }
  assert(offenders.length === 0, `以下选择器未加 .wmc- 前缀：\n      ${offenders.slice(0, 8).join('\n      ')}`);
});

test('CSS 括号配平', () => {
  for (const file of CSS_FILES) {
    const css = stripComments(read(file));
    const open = (css.match(/{/g) || []).length;
    const close = (css.match(/}/g) || []).length;
    eq(open, close, `${file} 花括号不配平`);
  }
});

test('var(--x) 引用的变量都已在 tokens 中定义', () => {
  const { defined, used } = collectCssVariables(CSS_FILES);
  const missing = [...used].filter((v) => !defined.has(v));
  assert(missing.length === 0, `未定义的变量：${missing.join(', ')}`);
});

test('字体链包含宋体兜底（SimSun / Noto Serif SC）', () => {
  const tokens = read('styles/wmc-tokens.css');
  assert(tokens.includes('Noto Serif SC'), '应包含 Noto Serif SC');
  assert(tokens.includes('SimSun'), '应包含 SimSun 兜底');
  assert(tokens.includes('--wmc-font-serif'), '应定义 --wmc-font-serif');
});

test('全局配色符合水墨青绿规范', () => {
  const tokens = read('styles/wmc-tokens.css');
  assert(/--wmc-bg:\s*#F4F7F6/i.test(tokens), '页面底色必须是浅青灰 #F4F7F6');
  assert(/--wmc-deep:\s*#2B3A42/i.test(tokens), '主色必须是黛蓝 #2B3A42');
  assert(/--wmc-teal:\s*#3E4E59/i.test(tokens), '次色必须是青灰蓝 #3E4E59');
  assert(/--wmc-jade:\s*#4E8C7E/i.test(tokens), '青玉色必须是 #4E8C7E');
  assert(/--wmc-cinnabar:\s*#C04851/i.test(tokens), '朱砂红必须是 #C04851（仅作点缀）');
});

test('字体链以 SimSun 为首选', () => {
  const tokens = read('styles/wmc-tokens.css');
  const match = tokens.match(/--wmc-font-serif:\s*([^;]+);/);
  assert(match, '未找到 --wmc-font-serif');
  const stack = match[1].trim();
  assert(/^"SimSun"/.test(stack), `宋体必须排在第一位，当前：${stack}`);
  assert(stack.includes('Songti SC'), '应包含 Songti SC 兜底（macOS）');
  assert(stack.includes('serif'), '应以 serif 收尾');
});

group('C. HTML ↔ CSS ↔ JS 一致性');

const cssClasses = collectCssClasses(CSS_FILES);
const htmlClasses = collectHtmlClasses(HTML_FILES);
const htmlHooks = collectHtmlHooks(HTML_FILES);

test('HTML 用到的类名都有 CSS 定义', () => {
  const missing = [...htmlClasses].filter((c) => !cssClasses.has(c));
  assert(missing.length === 0, `缺少样式定义：${missing.join(', ')}`);
});

test('JS 动态生成的类名也都有 CSS 定义', () => {
  // 扫描 JS 里 class: 'xxx' / classList.add('xxx') / getStyleClass 之类的字面量
  const used = new Set();
  for (const file of JS_FILES) {
    const js = stripJsComments(read(file));
    for (const m of js.matchAll(/class:\s*['"`]([^'"`]+)['"`]/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls.startsWith('wmc') && CLASS_RE.test(cls)) used.add(cls);
    }
    for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\(['"]([^'"]+)['"]/g)) {
      if (CLASS_RE.test(m[1])) used.add(m[1]);
    }
  }
  const missing = [...used].filter((c) => !cssClasses.has(c));
  assert(missing.length === 0, `JS 里使用了未定义的类：${missing.join(', ')}`);
});

test('JS 里用到的 data-wmc-* 挂载点都在 HTML 中', () => {
  const used = new Set();
  for (const file of JS_FILES) {
    const js = read(file);
    for (const m of js.matchAll(/\[(data-wmc-[\w-]+)\]/g)) used.add(m[1]);
  }
  const missing = [...used].filter((h) => !htmlHooks.has(h));
  assert(missing.length === 0, `JS 找不到这些挂载点：${missing.join(', ')}`);
});

test('面板片段与入口页的类名集合一致（防拷贝漂移）', () => {
  const pageClasses = new Set();
  for (const file of PAGE_FILES) {
    for (const m of read(file).matchAll(/class\s*=\s*["']([^"']+)["']/g)) {
      for (const cls of m[1].trim().split(/\s+/)) if (cls) pageClasses.add(cls);
    }
  }
  for (const file of HTML_FILES.filter((f) => f.startsWith('panels/'))) {
    for (const m of read(file).matchAll(/class\s*=\s*["']([^"']+)["']/g)) {
      for (const cls of m[1].trim().split(/\s+/)) {
        assert(pageClasses.has(cls),
          `${file} 的 ${cls} 未出现在任何入口页（index.html / app.html），两份拷贝已漂移`);
      }
    }
  }
});

group('D. 硬性规范');

test('不存在系统原生 <select>（必须用自定义下拉）', () => {
  const offenders = [];
  for (const file of HTML_FILES) {
    if (/<select[\s>]/i.test(stripHtmlComments(read(file)))) offenders.push(`${file} 出现 <select>`);
  }
  for (const file of JS_FILES) {
    const js = stripJsComments(read(file));
    if (/<select[\s>]/i.test(js)) offenders.push(`${file} 出现 <select>`);
    if (/createElement\(['"]select['"]\)/.test(js)) offenders.push(`${file} 动态创建了 select`);
  }
  assert(offenders.length === 0, offenders.join('；'));
});

test('不使用 input[type=range]（内存用自绘步进器）', () => {
  const offenders = [];
  for (const file of HTML_FILES) {
    if (/type\s*=\s*["']range["']/i.test(stripHtmlComments(read(file)))) offenders.push(file);
  }
  for (const file of JS_FILES) {
    if (/type\s*=\s*["']range["']/i.test(stripJsComments(read(file)))) offenders.push(file);
  }
  assert(offenders.length === 0, `以下文件使用了 range 输入：${offenders.join(', ')}`);
});

test('卡片网格使用 CSS Grid + auto-fill（3~4 列卡片流）', () => {
  const css = read('styles/wmc-download-center.css');
  assert(/\.wmc-dc__grid\s*{[^}]*display:\s*grid/s.test(css), '必须使用 grid 布局');
  assert(/repeat\(auto-fill,\s*minmax\(var\(--wmc-card-min\)/.test(css), '必须使用 auto-fill + minmax 自适应列数');
  assert(!/flex-direction:\s*column;\s*gap:\s*16px;\s*}/.test(css), '不要退回单列长条布局');
});

test('卡片具备角标 / 两行简介 / 底部下载量与获取按钮', () => {
  const js = read('scripts/wmc-download-center.js');
  assert(js.includes('wmc-mod__badge'), '应有来源角标');
  assert(js.includes('wmc-mod__desc'), '应有简介');
  assert(js.includes('wmc-mod__dl'), '应有下载量');
  assert(js.includes('wmc-mod__get'), '应有获取按钮');
  const css = read('styles/wmc-download-center.css');
  assert(/-webkit-line-clamp:\s*2/.test(css), '简介必须限制 2 行');
});

test('封面具备骨架屏与渐显', () => {
  const js = read('scripts/wmc-download-center.js');
  assert(js.includes('wmc-mod__coverSkeleton'), '应有封面骨架屏');
  assert(js.includes("classList.add('is-loaded')"), '应有渐显切换');
  const css = read('styles/wmc-download-center.css');
  assert(/\.wmc-mod__img\.is-loaded/.test(css), '应有 .is-loaded 样式');
  assert(/wmc-shimmer/.test(read('styles/wmc-primitives.css')), '骨架屏应有微光动画');
});

test('悬停上浮 + 阴影 + 金边发光', () => {
  const css = read('styles/wmc-download-center.css');
  assert(/\.wmc-mod:hover\s*{[^}]*translateY\(-3px\)/s.test(css), '悬停应上浮');
  assert(/\.wmc-mod:hover\s*{[^}]*var\(--wmc-sh-lift\)/s.test(css), '悬停应加深阴影');
  assert(/\.wmc-mod:hover\s*{[^}]*var\(--wmc-gold-glow\)/s.test(css), '悬停应有金边发光');
});

test('自定义下拉具备展开动画与键盘可达性', () => {
  const css = read('styles/wmc-primitives.css');
  assert(/\.wmc-select__panel\s*{[^}]*transition:/s.test(css), '下拉浮层应有过渡动画');
  assert(/\.wmc-select__panel\.is-open/.test(css), '应有 is-open 展开态');
  const js = read('scripts/wmc-custom-select.js');
  assert(js.includes('aria-expanded'), '触发器应有 aria-expanded');
  assert(js.includes("'ArrowDown'") && js.includes("'Escape'"), '应支持方向键与 Esc');
  assert(js.includes('role: \'listbox\'') || js.includes("role: 'listbox'"), '浮层应声明 listbox');
});

test('分类选中态＝金边卷轴 + 朱砂印章', () => {
  const css = read('styles/wmc-download-center.css');
  assert(/\.wmc-dc__cat--active/.test(css), '应有选中态');
  assert(/\.wmc-dc__seal/.test(css) && /\.wmc-dc__cat--active \.wmc-dc__seal/.test(css), '选中态应显示朱砂印章');
  assert(/--wmc-gold\)/.test(css), '选中态应使用金色描边');
});

test('运行环境面板：状态三色 + 左标签右值', () => {
  const css = read('styles/wmc-runtime-panel.css');
  assert(/\.wmc-env__row\s*{[^}]*grid-template-columns/s.test(css), '行应为两/三栏布局');
  assert(/\.wmc-env__value\.is-ok/.test(css), '正常态样式');
  assert(/\.wmc-env__value\.is-warn/.test(css), '警告态样式');
  assert(/\.wmc-env__value\.is-gold/.test(css), '提示态样式');
  const js = read('scripts/wmc-runtime-panel.js');
  for (const row of ['Java 运行时', '物理内存', '下载源', '游戏目录']) {
    assert(js.includes(`label: '${row}'`), `缺少「${row}」一行`);
  }
});

test('触底加载与分页兜底都存在', () => {
  const js = read('scripts/wmc-download-center.js');
  assert(js.includes('IntersectionObserver'), '应使用 IntersectionObserver 做触底加载');
  assert(js.includes('加载更多'), '应有「加载更多」按钮兜底');
  assert(js.includes('pageSize'), '应支持分页大小');
});

group('E. 资源引用与参考实现');

test('index.html 引用的样式与脚本都存在', () => {
  const html = stripHtmlComments(read('index.html'));
  const refs = [
    ...[...html.matchAll(/<link[^>]+href\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]),
  ];
  assert(refs.length >= 5, `引用数量异常：${refs.length}`);
  for (const ref of refs) {
    if (/^(https?:)?\/\//.test(ref)) continue;
    assert(existsSync(join(ROOT, ref)), `找不到被引用的文件：${ref}`);
  }
});

test('参考实现（preload / main）语法可解析', () => {
  for (const file of ['examples/preload.sample.js', 'examples/main-handlers.sample.js']) {
    const code = read(file);
    // 只做语法解析，不执行（examples 里会 require('electron')，Node 环境没有该模块）
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', '__dirname', code);
  }
});

test('IPC 通道名在 preload 与 main 之间一一对应', () => {
  const preload = read('examples/preload.sample.js');
  // 主进程侧有两份：整合模板（examples）与生产实现（main/register-ipc.js），两边加起来算全集
  const mainText = [read('examples/main-handlers.sample.js'), read('main/register-ipc.js')].join('\n');
  const channelsOf = (text) => new Set([...text.matchAll(/['"](wmc:[\w:-]+)['"]/g)].map((m) => m[1]));
  const pre = channelsOf(preload);
  const mn = channelsOf(mainText);
  const missing = [...pre].filter((c) => !mn.has(c));
  assert(missing.length === 0, `主进程缺少这些通道：${missing.join(', ')}`);
});

/* ============================================================ 任务 1 规格 */

group('F. 任务 1 · 全局框架与首页');

test('导航结构完整（四组 14 项 + 英文角标）', () => {
  const groups = shellMod.NAV_GROUPS;
  eq(groups.length, 4, '应有四组');
  eq(groups.map((g) => g.title).join('/'), '开始/游戏管理/资源中心/系统', '四组标题与顺序');

  const items = groups.flatMap((g) => g.items);
  eq(items.length, 14, '菜单应有 14 项');
  const ids = items.map((i) => i.id);
  const expectedIds = ['home', 'game', 'instances', 'saves', 'mod', 'modpack', 'resourcepack',
    'shader', 'map', 'datapack', 'plugin', 'account', 'runtime', 'settings'];
  eq(ids.join(','), expectedIds.join(','), '菜单 id 与顺序');

  // 中文名（资源中心那一组一个都不能少）
  const names = items.map((i) => i.cn);
  for (const want of ['首页', '游戏下载', '实例管理', '存档管理', '模组下载', '整合包下载',
    '资源包下载', '光影下载', '地图下载', '数据包下载', '服务器插件', '账户中心',
    'Java 与运行环境', '启动器设置']) {
    assert(names.includes(want), `缺少菜单项「${want}」`);
  }

  const badgeOf = Object.fromEntries(items.filter((i) => i.badge).map((i) => [i.id, i.badge]));
  const expectedBadges = {
    saves: 'SAVES', mod: 'MOD', modpack: 'PACK', resourcepack: 'RP',
    shader: 'SHADER', map: 'MAP', datapack: 'DATA', plugin: 'PLUGIN',
  };
  for (const [id, badge] of Object.entries(expectedBadges)) {
    eq(badgeOf[id], badge, `${id} 的角标应是 ${badge}`);
  }

  for (const item of items) {
    eq(item.en, item.en.toUpperCase(), `${item.id} 的英文标题应全大写`);
    assert(item.cn && item.icon, `${item.id} 应有中文名与图标`);
    assert(shellMod.PAGE_META[item.id], `${item.id} 应登记在 PAGE_META 里`);
  }

  // 除首页外每一项都必须有占位页文案（否则点进去是空页 / 死链）
  const shellSource = read('scripts/wmc-shell.js');
  for (const id of expectedIds.filter((i) => i !== 'home')) {
    assert(new RegExp(`\\n  ${id}: \\{`).test(shellSource), `导航项 ${id} 缺少占位页文案`);
  }
});

test('导航 CSS：深黛蓝 + 无任何暗纹 + 细短竖线选中态', () => {
  const tokens = read('styles/wmc-tokens.css');
  assert(/--wmc-nav-bg-from:\s*#2B3A42/i.test(tokens), '导航应是深黛蓝 #2B3A42');
  assert(/--wmc-nav-bg-to:\s*#22303A/i.test(tokens), '导航渐变止色应为 #22303A');
  assert(/--wmc-nav-pattern:\s*none/i.test(tokens), '祥云暗纹必须移除（应为 none）');

  const css = read('styles/wmc-shell.css');
  assert(!/\.wmc-app__nav::before/.test(css), '导航不能再有任何暗纹图层');
  assert(!/--wmc-nav-pattern/.test(css), '导航 CSS 不应再引用暗纹资源');
  assert(/\.wmc-nav__item::before[\s\S]{0,340}background:\s*var\(--wmc-jade\)/.test(css),
    '选中指示应是左侧青玉色细短竖线');
  assert(/\.wmc-nav__item--active::before\s*{\s*transform:\s*scaleY\(1\)/.test(css),
    '选中时竖线应立起');
  assert(/\.wmc-nav__item--active\s*{[\s\S]{0,220}background:\s*transparent/.test(css),
    '选中态不应有大面积高亮色块');
  assert(/\.wmc-nav__seal[\s\S]{0,460}border:\s*1px solid var\(--wmc-jade-line\)/.test(css),
    'Logo 印章应是青玉细描边');
  assert(/\.wmc-nav__badge/.test(css), '缺少角标样式');
  assert(/\.wmc-nav__item:hover[\s\S]{0,240}var\(--wmc-nav-hover\)/.test(css), '菜单项应有悬浮高亮');
});

test('侧边栏滚动与滚动条：内部平滑滚动 + 极细青色滚动条', () => {
  const html = read('app.html');
  assert(/class="wmc-nav__scroll" data-wmc-nav-menu/.test(html), 'HTML 里应有菜单滚动容器 .wmc-nav__scroll');
  assert(!html.includes('wmc-nav__spacer'), '旧的占位撑高元素应已移除');

  const css = read('styles/wmc-shell.css');
  // 导航自身不滚动，滚动区独立
  assert(/\.wmc-app__nav\s*{[\s\S]{0,400}overflow:\s*hidden;/.test(css), '导航自身不应滚动');
  assert(/\.wmc-nav__scroll\s*{[\s\S]{0,400}overflow-y:\s*auto/.test(css), '菜单区应支持内部滚动');
  assert(/\.wmc-nav__scroll\s*{[\s\S]{0,560}scroll-behavior:\s*smooth/.test(css), '菜单滚动应是平滑滚动');
  assert(/\.wmc-nav__scroll\s*{[\s\S]{0,620}overscroll-behavior:\s*contain/.test(css), '滚到边界不应带动窗口');

  // 极细 + 青色 + 无箭头：Chromium / Electron
  assert(/\.wmc-nav__scroll::-webkit-scrollbar\s*{[\s\S]{0,80}width:\s*6px/.test(css),
    'webKit 滚动条应是 6px 极细');
  assert(/\.wmc-nav__scroll::-webkit-scrollbar-thumb[\s\S]{0,220}background:\s*rgba\(122, 178, 164/.test(css),
    '滚动条滑块应是青色（青玉色）');
  assert(/::-webkit-scrollbar-button\s*{[\s\S]{0,120}display:\s*none/.test(css),
    '应隐藏滚动条两端的箭头按钮（Windows 默认粗条来源）');
  assert(/::-webkit-scrollbar-track\s*{\s*background:\s*transparent/.test(css), '滚动条轨道应透明');
  // Firefox：标准属性，且用 @supports 反向隔离，避免与 webkit 样式互相覆盖
  assert(/@supports not selector\(::-webkit-scrollbar\)/.test(css), '应为非 webkit 引擎单独兜底');
  assert(/scrollbar-width:\s*thin/.test(css), '兜底里应是细滚动条');
  assert(/scrollbar-color:\s*rgba\(122, 178, 164/.test(css), '兜底里滑块应是青色');

  // 顶部品牌与底部账号卡固定，不随菜单滚动
  assert(/\.wmc-nav__brand\s*{[\s\S]{0,300}flex:\s*0 0 auto/.test(css), '品牌区应固定在顶部');
  assert(/\.wmc-nav__user\s*{[\s\S]{0,300}flex:\s*0 0 auto/.test(css), '账号卡应固定在底部');
});

test('Logo 印章内容与品牌文案正确', () => {
  const html = read('app.html');
  assert(/wmc-nav__seal[^>]*>W</.test(html), '印章内应刻「W」');
  assert(html.includes('WMC'), '应有中文名「WMC」');
  assert(html.includes('WMC LAUNCHER'), '应有拼音 WMC LAUNCHER');
});

test('左下角账号卡规格（深青半透明 + 极细青边 + 状态点 + 版本号）', () => {
  const html = read('app.html');
  for (const hook of ['data-wmc-user', 'data-wmc-user-avatar', 'data-wmc-user-name',
    'data-wmc-user-state', 'data-wmc-user-version']) {
    assert(html.includes(hook), `缺少挂载点 ${hook}`);
  }
  assert(html.includes('冒险者'), '默认名应为冒险者');
  assert(html.includes('离线登录'), '应显示「离线登录」状态');

  const css = read('styles/wmc-shell.css');
  assert(/\.wmc-nav__user\s*{[\s\S]{0,460}background:\s*var\(--wmc-nav-card\)/.test(css),
    '账号卡应是深青半透明底');
  assert(/\.wmc-nav__user\s*{[\s\S]{0,560}border:\s*1px solid var\(--wmc-nav-card-line\)/.test(css),
    '账号卡应是极细青边');
  assert(/\.wmc-nav__dot[\s\S]{0,180}background:\s*var\(--wmc-jade\)/.test(css), '状态点应是青玉/绿');
  assert(/\.wmc-nav__version/.test(css), '应有版本号样式');
  assert(!/cloud-pattern/.test(css), '账号卡不应再使用云纹背景');
});

test('页目标题两行规范（青玉大写英文 + 墨黑宋体中文）', () => {
  const html = read('app.html');
  assert(html.includes('data-wmc-title-en') && html.includes('data-wmc-title-cn'), '缺少两行标题挂载点');
  assert(/data-wmc-title-en[^>]*>DASHBOARD</.test(html), '英文行应是全大写');

  const css = read('styles/wmc-shell.css');
  assert(/\.wmc-pageTitle__en[\s\S]{0,300}letter-spacing:\s*0\.36em/.test(css), '英文行应拉开字距');
  assert(/\.wmc-pageTitle__en[\s\S]{0,420}color:\s*var\(--wmc-jade-deep\)/.test(css),
    '英文行应是青玉色（与水墨体系一致）');
  assert(/\.wmc-pageTitle__en[\s\S]{0,460}text-transform:\s*uppercase/.test(css), '英文行应强制大写');
  assert(/\.wmc-pageTitle__cn[\s\S]{0,340}font-family:\s*var\(--wmc-font-serif\)/.test(css), '中文行应是宋体');
  assert(/\.wmc-pageTitle__cn[\s\S]{0,380}font-size:\s*var\(--wmc-fs-2xl\)/.test(css), '中文行应是大号');
  assert(/\.wmc-pageTitle__cn[\s\S]{0,440}color:\s*var\(--wmc-ink\)/.test(css), '中文行应是墨色（黑）');
});

test('首页结构齐全（微透光主面板 / 六宫格 / 四列卡片 / 水墨黄历）', () => {
  const html = read('app.html');
  for (const hook of ['data-wmc-hero-sub', 'data-wmc-hero-status', 'data-wmc-launch',
    'data-wmc-quicks', 'data-wmc-recs', 'data-wmc-almanac-title', 'data-wmc-almanac-rows']) {
    assert(html.includes(hook), `缺首页挂载点 ${hook}`);
  }
  for (const cls of ['wmc-hero__deco', 'wmc-hero__stamp', 'wmc-sealBtn', 'wmc-quicks',
    'wmc-home__bottom', 'wmc-home__recGrid', 'wmc-almanac__fanRibs', 'wmc-almanac__seal']) {
    assert(html.includes(cls), `首页缺少 ${cls}`);
  }
  // 六宫格卡片是 JS 生成的，类名在脚本里
  assert(read('scripts/wmc-home.js').includes('wmc-quick__icon'), '六宫格卡片应由 JS 生成（含图标）');
  // 顶部栏一行装下标题 + 搜索 + 齿轮 + 窗口键（没有独立状态栏了）
  for (const hook of ['data-wmc-title-en', 'data-wmc-title-cn', 'data-wmc-search', 'data-wmc-gear']) {
    assert(html.includes(hook), `顶部栏缺少挂载点 ${hook}`);
  }
  assert(!html.includes('wmc-statusbar'), '独立状态栏应已撤回');

  const tokens = read('styles/wmc-tokens.css');
  assert(/--wmc-ink-mountain:\s*url\("data:image\/svg\+xml/.test(tokens), '应内联水墨远山装饰');

  const css = read('styles/wmc-home.css');
  assert(/\.wmc-hero\s*{[\s\S]{0,560}rgba\(255, 255, 255, 0\.94\)/.test(css), '主面板应是白底 / 微透光');
  assert(/\.wmc-hero\s*{[\s\S]{0,760}backdrop-filter:\s*blur/.test(css), '主面板应有微透光效果');
  assert(/\.wmc-hero__deco[\s\S]{0,340}var\(--wmc-ink-mountain\)/.test(css), '主面板应贴水墨远山');
  assert(/\.wmc-quicks[\s\S]{0,200}grid-template-columns:\s*repeat\(6/.test(css), '六宫格应是 6 列');
  assert(/\.wmc-quick\s*{[\s\S]{0,780}backdrop-filter:\s*blur/.test(css), '快捷卡片应是磨砂感');
  assert(/\.wmc-home__bottom[\s\S]{0,220}grid-template-columns:\s*minmax\(0, 1fr\) 300px/.test(css),
    '底部应是「左推荐 + 右黄历」两列');
  assert(/\.wmc-home__recGrid[\s\S]{0,220}minmax\(196px, 1fr\)/.test(css), '推荐流应是多列卡片');
  assert(/\.wmc-sealBtn[\s\S]{0,660}var\(--wmc-cinnabar\)/.test(css), '启动按钮应是朱砂印章质感');
  assert(/\.wmc-almanac\s*{[\s\S]{0,460}var\(--wmc-letter-lines\)/.test(css), '黄历应是信笺（竖格）样式');
  assert(/\.wmc-almanac__fanRibs[\s\S]{0,460}repeating-conic-gradient/.test(css), '折扇应是纯 CSS 绘制');
  assert(/\.wmc-quick:hover[\s\S]{0,240}translateY\(-3px\)/.test(css), '六宫格卡片应有悬浮上浮');
});

test('首页只保留这一版结构（新结构的类必须已撤回）', () => {
  const html = read('app.html');
  const css = read('styles/wmc-home.css');
  const shellCss = read('styles/wmc-shell.css');
  for (const gone of ['wmc-console', 'wmc-strip', 'wmc-recent', 'wmc-worldCard', 'wmc-block__',
    'wmc-side', 'wmc-notice', 'wmc-statusbar']) {
    assert(!html.includes(gone), `app.html 仍残留新结构 ${gone}`);
    assert(!css.includes(`.${gone}`), `wmc-home.css 仍残留新样式 .${gone}`);
    assert(!shellCss.includes(`.${gone}`), `wmc-shell.css 仍残留新样式 .${gone}`);
  }
  assert(!/--wmc-banner-from/.test(css), '首页 CSS 不应引用红金 Banner 变量');
  assert(!/--wmc-gold/.test(css), '首页 CSS 不应出现金色');
  assert(!/--wmc-gold/.test(shellCss), '外壳 CSS 不应出现金色');

  // 点缀层级：青玉为主，朱砂克制
  const jadeUses = (css.match(/--wmc-jade/g) || []).length;
  const cinnabarUses = (css.match(/--wmc-cinnabar/g) || []).length;
  assert(jadeUses > cinnabarUses,
    `青玉应是主要点缀（实际：青玉 ${jadeUses} 处 / 朱砂 ${cinnabarUses} 处）`);
  assert(cinnabarUses <= 20, `朱砂红应保持克制，当前 ${cinnabarUses} 处`);
});

test('品牌底线：全站只有 WMC，且不出现旧品牌名与个人名字', () => {
  const files = [...HTML_FILES, ...JS_FILES, ...CSS_FILES, 'INTEGRATION.md'];
  const forbidden = [
    ['LP' + 'CL', '旧品牌名'],
    ['创想' + '起源', '旧中文名'],
    ['冰' + '度', '个人名字'],
  ];
  for (const file of files) {
    const text = read(file);
    for (const [word, label] of forbidden) {
      assert(!text.includes(word), `${file} 出现了${label}「${word}」`);
    }
  }
  const html = read('app.html');
  assert(/wmc-nav__seal[^>]*>W</.test(html), 'Logo 印章应刻「W」');
  assert(/wmc-nav__brandName">WMC</.test(html), '品牌名应是 WMC');
  assert(html.includes('冒险者'), '账号/欢迎语应使用「冒险者」');
  assert(read('scripts/wmc-mock-data.js').includes("name: '冒险者'"), '默认账号名应是「冒险者」');
});

test('【逻辑底线】没有版本时显示「没有版本」，且不写死假版本号', async () => {
  const bridge = bridgeMod.createBridge({ forceMock: true, onWarn: () => {} });
  const config = await bridge.configGet();
  eq(config.lastVersionId, '', '默认配置的版本必须为空（不能预置写死的版本号）');

  const mockText = read('scripts/wmc-mock-data.js');
  assert(!/1\.21\.4/.test(mockText), '模拟数据里不应再出现写死的 1.21.4');
  const homeJs = read('scripts/wmc-home.js');
  assert(homeJs.includes("NO_VERSION_TEXT = '没有版本'"), '首页应显式定义「没有版本」文案');
  assert(/hasVersion \? version : NO_VERSION_TEXT|hasVersion\s*\?\s*version\s*:\s*NO_VERSION_TEXT/.test(homeJs),
    '没有版本时必须回落到「没有版本」');
  assert(homeJs.includes('wmc-hero__chip--warn'), '没有版本时应使用警示态小签');
  assert(homeJs.includes('还没有可用版本'), '没有版本时点启动应给出明确提示');

  // 存档数据同样不能假装有具体版本号
  const worlds = await bridge.recentWorlds(3);
  for (const world of worlds) {
    assert(!/\d+\.\d+/.test(String(world.version || '')), `存档里不应写死版本号：${world.version}`);
  }
});

test('六宫格为 6 项，且含「环境体检 / 存档速览」两个特色', async () => {
  const bridge = bridgeMod.createBridge({ forceMock: true, onWarn: () => {} });
  const entries = await bridge.quickEntries();
  eq(entries.length, 6, '六宫格应有 6 个入口');
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  for (const id of ['health', 'worlds']) {
    assert(byId[id], `缺少特色入口 ${id}`);
    eq(byId[id].tag, '特色', `${id} 应标注为特色功能`);
  }
  eq(byId.health.action, 'health', '环境体检入口的动作');
  eq(byId.worlds.action, 'worlds', '存档速览入口的动作');
  assert(/Java/.test(byId.health.desc) && /存档|世界/.test(byId.worlds.desc), '特色入口说明应贴合功能');
  for (const entry of entries) {
    assert(entry.id && entry.name && entry.icon, `入口字段不完整：${JSON.stringify(entry)}`);
  }
});

test('水墨黄历按日期确定性生成，且含「挖矿建房子 / 打末影龙」', () => {
  const a = mockData.mockFortune(new Date(2026, 9, 31));
  const b = mockData.mockFortune(new Date(2026, 9, 31));
  eq(a.level, b.level, '同一天运势应一致（反复刷新不会变）');
  assert(a.good.includes('挖矿建房子'), `宜应含「挖矿建房子」，实际 ${a.good.join('，')}`);
  assert(a.bad.includes('打末影龙'), `忌应含「打末影龙」，实际 ${a.bad.join('，')}`);
  assert(a.luck >= 40 && a.luck <= 100, `幸运值应在 40~100，实际 ${a.luck}`);
  assert(typeof a.note === 'string' && a.note.length > 6, '应有一句宜忌说明');
});

test('外壳与首页脚本导出关键 API（含卡片工厂复用）', () => {
  assert(typeof shellMod.createShell === 'function', '应导出 createShell');
  assert(Array.isArray(shellMod.NAV_GROUPS), '应导出 NAV_GROUPS');
  assert(typeof homeMod.mountHome === 'function', '应导出 mountHome');
  assert(typeof homeMod.buildHealthReport === 'function', '环境体检应导出纯函数便于单测');
  assert(typeof dcMod.createResourceCard === 'function', '卡片工厂应导出（供首页推荐流复用）');
  assert(typeof dcMod.applyCardProgress === 'function', '进度函数应导出');
});

test('环境体检报告：判据正确（缺 Java / 内存越界 / 依赖待接入）', () => {
  const bad = homeMod.buildHealthReport({
    config: { maxMemoryMb: 99999, lastVersionId: '' },
    system: { totalMemMb: 16384, freeMemMb: 9000 },
    javaList: [],
  });
  eq(bad.rows.length, 3, '体检应有 3 项');
  eq(bad.rows[0].level, 'warn', '没检测到 Java 应报警');
  eq(bad.rows[1].level, 'warn', '内存超出物理上限应报警');
  eq(bad.rows[2].level, 'warn', '未选版本时依赖检查应提示');

  const good = homeMod.buildHealthReport({
    config: { maxMemoryMb: 4096, lastVersionId: '1.21.4' },
    system: { totalMemMb: 16384, freeMemMb: 9000 },
    javaList: [{ name: 'Java 21', vendor: 'Adoptium', ok: true }],
  });
  eq(good.rows[0].level, 'ok', '检测到 Java 应正常');
  eq(good.rows[1].level, 'ok', '内存合理应正常');
  eq(good.warn, 0, '正常环境下不应有告警');
  assert(/Java 21/.test(good.rows[0].value), '体检应回报具体 Java 版本');
});

test('bridge 提供窗口 / 启动 / 账号 / 存档能力且 mock 不谎报成功', async () => {
  const bridge = bridgeMod.createBridge({ forceMock: true, onWarn: () => {} });
  for (const fn of ['minimize', 'maximize', 'close']) {
    assert(typeof bridge.windowControls[fn] === 'function', `缺少 windowControls.${fn}`);
  }
  const account = await bridge.account();
  assert(account && account.name, 'account 应返回账号');
  assert(['offline', 'microsoft', 'littleskin'].includes(account.type), `账号类型取值非法：${account.type}`);
  const launched = await bridge.launchGame({});
  eq(launched.started, false, 'mock 模式下不应假装启动成功');

  const worlds = await bridge.recentWorlds(3);
  eq(worlds.length, 3, '存档速览应返回最近 3 个世界');
  assert(worlds[0].name && worlds[0].version, `世界字段不完整：${JSON.stringify(worlds[0])}`);
});

/* ============================================================ 游戏下载 + 拖拽安装 */

group('G. 游戏下载 + 全局拖拽安装');

const { createRequire } = await import('node:module');
const { mkdtempSync, writeFileSync: writeTmp, readFileSync: readTmp, existsSync: existsTmp,
  rmSync, mkdirSync: mkdirTmp } = await import('node:fs');
const { tmpdir } = await import('node:os');
const nodeRequire = createRequire(import.meta.url);
const pathMod = await import('node:path');
const zipMain = nodeRequire(join(ROOT, 'main', 'wmc-zip.js'));
const versionMain = nodeRequire(join(ROOT, 'main', 'wmc-version-service.js'));
const modpackMain = nodeRequire(join(ROOT, 'main', 'wmc-modpack-service.js'));
const nodeZlib = nodeRequire('node:zlib');

/** 测试用：手写一个合法 zip（stored / deflate 两种条目都支持） */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const crc32 = (buf) => (typeof nodeZlib.crc32 === 'function' ? nodeZlib.crc32(buf) : 0);

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.deflate ? 8 : 0;
    const body = entry.deflate ? nodeZlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centralParts.push(cd, name);
    offset += local.length + name.length + body.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

test('内置 ZIP 读取：stored / deflate / 目录列举 / zip-slip 防护', () => {
  const buf = buildZip([
    { name: 'manifest.json', data: '{"name":"测试"}', deflate: true },
    { name: 'overrides/mods/a.jar', data: Buffer.from([0x50, 0x4b, 0x03, 0x04]), deflate: false },
    { name: 'readme.txt', data: 'hello wmc' },
    { name: '../escape.txt', data: 'evil' },
    { name: 'C:/windows/evil.dll', data: 'evil' },
  ]);
  const zip = zipMain.ZipReader.fromBuffer(buf, 'test.zip');
  eq(zip.entries.length, 5, '应读出 5 个条目');
  eq(zip.readText('manifest.json'), '{"name":"测试"}', 'deflate 条目内容');
  eq(zip.readText('readme.txt'), 'hello wmc', 'stored 条目内容');
  eq(zip.read('overrides/mods/a.jar').length, 4, '二进制条目长度');
  assert(zip.has('README.TXT'), 'has() 应忽略大小写');
  eq(zip.find(/\.jar$/).length, 1, 'find 支持正则');
  assert(zipMain.isUnsafeName('../escape.txt'), '应识别 ../ 穿越');
  assert(zipMain.isUnsafeName('C:/windows/evil.dll'), '应识别盘符绝对路径');
  assert(!zipMain.isUnsafeName('overrides/mods/a.jar'), '正常路径不应被误判');
});

test('内置 ZIP 解压：真实落盘 + 跳过越界条目', () => {
  const dir = mkdtempSync(pathMod.join(tmpdir(), 'wmc-zip-'));
  try {
    const buf = buildZip([
      { name: 'a.txt', data: 'A' },
      { name: 'sub/b.txt', data: 'B', deflate: true },
      { name: '../outside.txt', data: 'X' },
    ]);
    const zip = zipMain.ZipReader.fromBuffer(buf, 'x.zip');
    const result = zip.extractTo(dir);
    eq(result.extracted, 2, '应解压 2 个正常文件');
    eq(result.skipped.length, 1, '越界条目应被跳过');
    eq(readTmp(pathMod.join(dir, 'a.txt'), 'utf8'), 'A', '落盘内容 a');
    eq(readTmp(pathMod.join(dir, 'sub', 'b.txt'), 'utf8'), 'B', '落盘内容 b（含子目录）');
    assert(!existsTmp(pathMod.join(pathMod.dirname(dir), 'outside.txt')), '不应写出目标目录之外');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('整合包识别：CurseForge / Modrinth / PCL2 / HMCL / MultiMC / 未知', () => {
  const cases = [
    {
      kind: 'curseforge',
      entries: [{
        name: 'manifest.json',
        data: JSON.stringify({
          name: '山河整合包', version: '1.2.0', author: 'WMC',
          minecraft: { version: '1.21.1', modLoaders: [{ id: 'forge-52.0.1', primary: true }] },
          files: [{ projectID: 1, fileID: 2, required: true }, { projectID: 3, fileID: 4, required: false }],
          overrides: 'overrides',
        }),
      }, { name: 'overrides/mods/x.jar', data: 'jar' }],
      expect: { meta: { mcVersion: '1.21.1', loaderKind: 'forge', fileCount: 2 } },
    },
    {
      kind: 'modrinth',
      entries: [{
        name: 'modrinth.index.json',
        data: JSON.stringify({
          formatVersion: 1, name: '竹林轻量包', versionId: 'v3',
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
          files: [{ path: 'mods/a.jar', hashes: { sha1: 'abc' }, downloads: ['https://example.invalid/a.jar'] }],
        }),
      }],
      expect: { meta: { mcVersion: '1.20.1', loaderKind: 'fabric', fileCount: 1 } },
    },
    { kind: 'pcl2', entries: [{ name: 'PCL/Setup.ini', data: 'Name=云顶整合包\nVersion=2.1\nVersionArgument=1.19.2' }],
      expect: { meta: { name: '云顶整合包', mcVersion: '1.19.2' } } },
    { kind: 'hmcl', entries: [{ name: 'mcbbs.packmeta', data: JSON.stringify({ name: 'mcbbs 包', gameVersion: '1.18.2' }) }],
      expect: { meta: { name: 'mcbbs 包', mcVersion: '1.18.2' } } },
    { kind: 'multimc', entries: [
      { name: 'instance.cfg', data: 'name=Prism 实例' },
      { name: 'mmc-pack.json', data: JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.16.5' }, { uid: 'net.fabricmc.fabric-loader', version: '0.14.0' }] }) },
    ], expect: { meta: { mcVersion: '1.16.5', loaderKind: 'fabric' } } },
    { kind: 'unknown', entries: [{ name: 'readme.txt', data: 'nothing here' }], expect: { meta: {} } },
  ];

  for (const item of cases) {
    const zip = zipMain.ZipReader.fromBuffer(buildZip(item.entries), `${item.kind}.zip`);
    const detected = modpackMain.detectSignature(zip);
    eq(detected.kind, item.kind, `${item.kind} 应被正确识别`);
    for (const [key, value] of Object.entries(item.expect.meta || {})) {
      eq(detected.meta[key], value, `${item.kind} 的 ${key}`);
    }
  }
});

test('整合包安装：解压进版本隔离目录 + 写 wmc-pack.json 标记', () => {
  const dir = mkdtempSync(pathMod.join(tmpdir(), 'wmc-pack-'));
  try {
    const versionsDir = pathMod.join(dir, 'versions');
    const packPath = pathMod.join(dir, '山河整合包.zip');
    writeTmp(packPath, buildZip([
      { name: 'manifest.json', data: JSON.stringify({
        name: '山河整合包', version: '1.0.0',
        minecraft: { version: '1.21.1', modLoaders: [{ id: 'forge-52.0.1' }] }, files: [{ projectID: 1, fileID: 2 }],
      }) },
      { name: 'overrides/config/a.toml', data: 'key=1', deflate: true },
      { name: '../x.txt', data: 'evil' },
    ]));

    const report = modpackMain.inspectPack(packPath);
    assert(report.ok, '应为可识别的整合包');
    eq(report.kind, 'curseforge', '识别为 CurseForge');
    eq(report.evidence, 'manifest.json', '证据文件');
    assert(report.hasOverrides, '应检到 overrides');

    const installed = modpackMain.installPack({ filePath: packPath, versionsDir });
    assert(existsTmp(pathMod.join(installed.targetDir, 'wmc-pack.json')), '应写入 wmc-pack.json 标记');
    assert(existsTmp(pathMod.join(installed.targetDir, 'overrides', 'config', 'a.toml')), '应解压 overrides 内容');
    const marker = JSON.parse(readTmp(pathMod.join(installed.targetDir, 'wmc-pack.json'), 'utf8'));
    eq(marker.packKind, 'curseforge', '标记里的包类型');
    eq(marker.mcVersion, '1.21.1', '标记里的游戏版本');
    eq(marker.loaderKind, 'forge', '标记里的加载器');
    eq(installed.skipped.length, 1, '越界条目应被跳过');

    // 同名再装一次应自动改名，不覆盖已有实例
    const again = modpackMain.installPack({ filePath: packPath, versionsDir });
    assert(again.isolation !== installed.isolation, '第二次安装应生成新的隔离名');
    eq(modpackMain.safeFolderName('a/b:c*?d'), 'a b c d', '隔离名应过滤非法字符');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本服务纯函数（基于真实抓取的清单切片）', () => {
  const fixture = JSON.parse(read('tools/fixtures/manifest.sample.json'));
  const normalized = versionMain.normalizeManifest(fixture);
  eq(normalized.versions.length, fixture.versions.length, '规范化后数量一致');
  eq(normalized.latest.release, '26.3', '真实 latest.release');
  assert(/^\d/.test(normalized.latest.snapshot), '真实 latest.snapshot');

  const counts = normalized.versions.reduce((acc, v) => { acc[v.category] = (acc[v.category] || 0) + 1; return acc; }, {});
  eq(counts.fools, 8, '愚人节版应识别出 8 个（真实清单里的 8 个）');
  assert(counts.release >= 10 && counts.snapshot >= 10 && counts.old >= 10,
    `各类型都要有：${JSON.stringify(counts)}`);

  for (const id of ['15w14a', '1.RV-Pre1', '3D Shareware v1.34', '20w14infinite',
    '22w13oneblockatatime', '23w13a_or_b', '24w14potato', '25w14craftmine']) {
    const hit = normalized.versions.find((v) => v.id === id);
    eq(hit?.category, 'fools', `${id} 应归入愚人节版`);
  }
  eq(versionMain.classifyVersion('old_beta', 'b1.8.1'), 'old', 'old_beta → 远古版');
  eq(versionMain.classifyVersion('release', '26.3'), 'release', '正式版');
  eq(versionMain.classifyVersion('snapshot', '26.4-snapshot-6'), 'snapshot', '预览版');

  const releases = versionMain.filterVersions(normalized.versions, { category: 'release', limit: 5 });
  eq(releases.length, 5, '限制 5 条');
  for (let i = 1; i < releases.length; i += 1) {
    assert(String(releases[i - 1].releaseTime) >= String(releases[i].releaseTime), '应按发布时间倒序');
  }
  const searched = versionMain.filterVersions(normalized.versions, { category: 'release', query: '26.3' });
  assert(searched.length >= 1 && searched.every((v) => v.id.includes('26.3')), '搜索应命中 26.3');
  eq(versionMain.pickLatest(normalized.versions, 'release', normalized.latest).id, '26.3', '最新正式版');
  eq(versionMain.sources().length, 2, '应有两个下载源');
});

test('架构底线：渲染层不联网、不读文件；IO 全在主进程', () => {
  const rendererFiles = JS_FILES.filter((f) => f.startsWith('scripts/'));
  for (const file of rendererFiles) {
    const code = stripJsComments(read(file));
    assert(!/\bfetch\s*\(/.test(code), `${file} 不应发起网络请求（fetch）`);
    assert(!/XMLHttpRequest/.test(code), `${file} 不应使用 XMLHttpRequest`);
    assert(!/require\(\s*['"]node:/.test(code), `${file} 不应直接 require node 模块`);
    assert(!/require\(\s*['"](fs|path|zlib|https|http)['"]\s*\)/.test(code), `${file} 不应直接读文件/网络`);
  }
  // 主进程才是联网与解压的地方
  const mainFiles = readdirSync(join(ROOT, 'main')).filter((f) => f.endsWith('.js'));
  assert(mainFiles.includes('wmc-version-service.js'), '缺少主进程版本服务');
  assert(mainFiles.includes('wmc-zip.js'), '缺少主进程 ZIP 读取');
  assert(mainFiles.includes('wmc-modpack-service.js'), '缺少主进程整合包服务');
  assert(mainFiles.includes('register-ipc.js'), '缺少主进程 IPC 注册');
  assert(/\bfetch\s*\(/.test(read('main/wmc-version-service.js')), '版本服务应在主进程里 fetch');
  assert(/node:zlib/.test(read('main/wmc-zip.js')), 'ZIP 读取应在主进程里用 zlib');

  const preload = read('examples/preload.sample.js');
  for (const api of ['versions', 'modpack', 'webUtils', 'getDroppedPath']) {
    assert(preload.includes(api), `preload 缺少 ${api}`);
  }
  // 拖拽必须走 webUtils.getPathForFile（Electron 32+ 已移除 File.path）
  assert(/webUtils\.getPathForFile/.test(preload), 'preload 应使用 webUtils.getPathForFile');
});

test('版本与整合包：桥接层不做假数据兜底', () => {
  const bridge = read('scripts/wmc-bridge.js');
  for (const cap of ['versionsList', 'versionsLatest', 'versionsDetail', 'versionsSources',
    'modpackInspect', 'modpackInstall', 'modpackPick']) {
    assert(bridge.includes(`'${cap}'`), `桥接缺少 ${cap}`);
  }
  assert(/strictCall/.test(bridge), '版本/整合包应走严格调用（不回退假数据）');
  assert(!/mockVersionList|mockVersions\b/.test(read('scripts/wmc-mock-data.js')),
    '模拟数据里不应有版本清单');
  const mockData = read('scripts/wmc-mock-data.js');
  assert(!/old_beta|old_alpha/.test(mockData), '模拟数据不应混入版本清单字段');
  assert(/NO_IPC/.test(bridge), '缺少 IPC 时应有明确错误码');
});

test('下载页 UI：最新版大卡片 / 筛选栏 / 极简列表 / 骨架屏 / 红字错误', () => {
  const html = read('app.html');
  for (const hook of ['data-wmc-download', 'data-wmc-dl-latest-version', 'data-wmc-dl-latest-meta',
    'data-wmc-dl-install-all', 'data-wmc-dl-search', 'data-wmc-dl-category', 'data-wmc-dl-source',
    'data-wmc-dl-refresh', 'data-wmc-dl-count', 'data-wmc-dl-list']) {
    assert(html.includes(hook), `下载页缺少挂载点 ${hook}`);
  }
  assert(/data-wmc-template="game"/.test(html), '缺少游戏下载页模板');
  assert(/styles\/wmc-game-download\.css/.test(html), 'HTML 应引入下载页样式');
  assert(/styles\/wmc-dragdrop\.css/.test(html), 'HTML 应引入拖拽样式');

  const js = read('scripts/wmc-game-download.js');
  assert(js.includes("'release'") && js.includes("'snapshot'") && js.includes("'old'") && js.includes("'fools'"),
    '四个分类都要有（正式版 / 预览版 / 远古版 / 愚人节版）');
  assert(js.includes('visibleItems') && js.includes('toLowerCase().includes'), '搜索应是前端内存过滤');
  assert(js.includes("bridge.versionsList") && js.includes('bridge.versionsDetail'), '数据应来自主进程接口');
  assert(/一键安装最新版/.test(read('app.html')), '按钮文案应写在 HTML 骨架里');
  assert(/最新正式版：/.test(js), '大卡片应显示「最新正式版：xx」');

  const css = read('styles/wmc-game-download.css');
  assert(/\.wmc-dl__latest\s*{[\s\S]{0,700}var\(--wmc-ink-mountain\)|\.wmc-dl__deco[\s\S]{0,320}var\(--wmc-ink-mountain\)/.test(css),
    '大卡片应有极淡水墨山峦背景');
  assert(/\.wmc-dl__row:hover\s*{\s*background:\s*rgba\(78, 140, 126/.test(css), '整行悬浮应是极浅青色');
  assert(/\.wmc-dl__rowAct\s*{[\s\S]{0,300}var\(--wmc-cinnabar\)/.test(css), '安装按钮应是朱砂红');
  assert(/\.wmc-dl__skeleton/.test(css) && /wmc-dl-bone/.test(css), '应有骨架屏动画');
  assert(/\.wmc-dl__error[\s\S]{0,220}var\(--wmc-cinnabar-dark\)/.test(css), '错误提示应是红字');
  assert(/\.wmc-dl__tag--fools/.test(css), '愚人节版标签应有独立配色');
});

test('全局拖拽：水墨遮罩 + 文案 + 支持 .zip / .mrpack', () => {
  const js = read('scripts/wmc-dragdrop.js');
  assert(js.includes('松开鼠标以解析并安装整合包'), '遮罩文案必须与需求一致');
  assert(/ACCEPT_EXT\s*=\s*\[[^\]]*\.zip[^\]]*\.mrpack/.test(js), '应同时支持 .zip 与 .mrpack');
  for (const evt of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    assert(js.includes(`addEventListener('${evt}'`), `应监听 ${evt}`);
  }
  assert(js.includes('dataTransfer.dropEffect'), 'dragover 应设置 dropEffect');
  assert(js.includes('bridge.modpackInspect') && js.includes('bridge.modpackInstall'), '识别与安装都走主进程');
  assert(js.includes('bridge.filePathOf'), '拖拽取路径应走桥接（preload 的 webUtils）');
  assert(js.includes('mountGlobalDrop'), '应导出全局挂载函数');

  const css = read('styles/wmc-dragdrop.css');
  assert(/\.wmc-drop__mask[\s\S]{0,320}rgba\(20, 30, 34, 0\.52\)/.test(css), '遮罩应是半透明墨色');
  assert(/\.wmc-drop__mask[\s\S]{0,420}var\(--wmc-ink-mountain\)/.test(css), '遮罩应带水墨纹理');
  assert(/\.wmc-drop__panel[\s\S]{0,420}border:\s*1px dashed var\(--wmc-jade\)/.test(css), '拖拽框应是青玉虚线');
  assert(/\.wmc-drop\.is-active\s*{\s*opacity:\s*1/.test(css), '拖拽时应淡入');
  assert(/\.wmc-dialog__panel[\s\S]{0,420}var\(--wmc-letter-lines\)/.test(css), '确认弹窗应是信笺样式');

  // 外壳里必须真的挂上了
  const shellBoot = read('scripts/app-shell.js');
  assert(shellBoot.includes('mountGlobalDrop'), 'app-shell 应挂载全局拖拽');
  assert(/shell\.addPage\('game'/.test(shellBoot), 'app-shell 应注册游戏下载页');
});

/* ============================================================ 汇总输出 */

await runAll();

const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;

if (VERBOSE) {
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} [${r.group}] ${r.name} (${r.ms}ms)${r.ok ? '' : '\n      ' + r.detail}`);
  }
  console.log('');
}

if (failed.length) {
  console.log('未通过的检查：');
  for (const r of failed) console.log(`  ❌ [${r.group}] ${r.name}\n      ${r.detail}`);
  console.log('');
}

console.log(`WMC 界面自检：共 ${results.length} 项，通过 ${passed}，失败 ${failed.length}`);
console.log(`HTML 类名 ${htmlClasses.size} 个 · CSS 类名 ${cssClasses.size} 个 · 未定义类 ${[...htmlClasses].filter((c) => !cssClasses.has(c)).length} 个`);
process.exit(failed.length ? 1 : 0);