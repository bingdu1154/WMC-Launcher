/**
 * WMC 面板 · DOM 与格式化工具
 * ---------------------------------------------------------------------------
 * 零依赖，纯 ES Module。所有导出都是纯函数或极薄封装，方便单测（tools/check-ui.mjs 会跑）。
 */

/** 内联 SVG 图标（24×24 视图框）。用 currentColor 继承文字色，便于主题化。 */
export const ICONS = {
  search: 'M10.5 3a7.5 7.5 0 1 0 4.55 13.45l4.5 4.5 1.4-1.4-4.5-4.5A7.5 7.5 0 0 0 10.5 3zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  download: 'M11 3h2v8h3.5L12 15.5 7.5 11H11V3zM5 17h14v2H5z',
  folder: 'M3 5h6l2 2h10v12H3V5zm2 2v10h14V9h-8.2l-2-2H5z',
  refresh: 'M17.65 6.35A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h7V4l-2.35 2.35z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z',
  minus: 'M5 11h14v2H5z',
  info: 'M11 7h2v2h-2V7zm0 4h2v6h-2v-6zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8z',
  cpu: 'M5 5h14v14H5V5zm4 4v6h6V9H9z',
  memory: 'M4 7h16v10H4V7zm3 3v4h3v-4H7zm7 0v4h3v-4h-3z',
  external: 'M14 3v2h3.6l-8.3 8.3 1.4 1.4L19 6.4V10h2V3h-7zM5 5h6v2H7v10h10v-4h2v6H5V5z',
  close: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.89 18.3 9.18 12 2.89 5.71 4.3 4.29l6.29 6.3 6.3-6.3z',
  // ---- 任务 1 新增：导航图标 ----
  home: 'M12 3 2 11h3v10h5v-6h4v6h5V11h3z',
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3 6.3 3.5L12 11.3 5.7 7.8 12 4.3z',
  pack: 'M3 7h18v13H3zm3-3h12v2H6z',
  palette: 'M12 3a9 9 0 0 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h1.5A4.5 4.5 0 0 0 21 10c0-4-4-7-9-7zm-4 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  shader: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5h1v3h-2V2zm0 17h1v3h-2v-3zM2 11h3v2H2zm17 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z',
  map: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3zm0 2.2 6 3v11.6l-6-3V5.2z',
  book: 'M5 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5V3zm2 2v14h10V5H7z',
  plug: 'M9 3h2v4h2V3h2v5a5 5 0 0 1-4 4.9V21h-2v-8.1A5 5 0 0 1 5 8V3h2v4h2z',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM10.4 2h3.2l.4 2.2 1.6.7 1.9-1.3 2.3 2.3-1.3 1.9.7 1.6 2.2.4v3.2l-2.2.4-.7 1.6 1.3 1.9-2.3 2.3-1.9-1.3-1.6.7-.4 2.2h-3.2l-.4-2.2-1.6-.7-1.9 1.3-2.3-2.3 1.3-1.9-.7-1.6-2.2-.4V9.4l2.2-.4.7-1.6-1.3-1.9 2.3-2.3 1.9 1.3 1.6-.7z',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 10c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z',
  sparkle: 'M12 2 13.8 8.2 20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z',
  boltSmall: 'M13 2 4 14h6l-1 8 9-12h-6z',
  winMax: 'M5 5h14v14H5zm2 2v10h10V7z',
  // 环境体检：心跳折线
  pulse: 'M2 13h4l2.5-7 3.5 12 2.5-5h7v2h-5.7l-3.3 6.6L8.3 12 7 15H2z',
  // 实例管理：三层叠放（版本 / 实例隔离）
  layers: 'M12 3 3 8l9 5 9-5-9-5zm0 2.3 4.6 2.6L12 10.5 7.4 7.9 12 5.3zM3 12l9 5 9-5-1.8-1-7.2 4-7.2-4L3 12zm0 4l9 5 9-5-1.8-1-7.2 4-7.2-4L3 16z',
};

/**
 * 创建元素。
 * @param {string} tag
 * @param {object} [props] 支持 class/text/html/attrs/dataset/style/on/children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const { class: cls, className, text, html, attrs, dataset, style, on: handlers } = props;

  if (cls) node.className = cls;
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (html !== undefined && html !== null) node.innerHTML = html;

  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  if (dataset) for (const [k, v] of Object.entries(dataset)) {
    if (v !== null && v !== undefined) node.dataset[k] = String(v);
  }
  if (style) for (const [k, v] of Object.entries(style)) node.style.setProperty(k, String(v));
  if (handlers) for (const [type, fn] of Object.entries(handlers)) node.addEventListener(type, fn);

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 文档片段（批量插入，减少重排） */
export function frag(children = []) {
  const f = document.createDocumentFragment();
  for (const child of [].concat(children)) if (child) f.append(child);
  return f;
}

export const qs = (root, sel) => (root || document).querySelector(sel);
export const qsa = (root, sel) => Array.from((root || document).querySelectorAll(sel));

/** 绑定事件，返回解绑函数（便于 destroy() 时清理） */
export function on(target, type, handler, opts) {
  if (!target) return () => {};
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
}

/**
 * 事件委托：滚动/长列表里比逐个绑定便宜得多。
 */
export function delegate(root, selector, type, handler) {
  return on(root, type, (event) => {
    const match = event.target instanceof Element ? event.target.closest(selector) : null;
    if (match && root.contains(match)) handler(event, match);
  });
}

/** 内联 SVG 字符串（用于 icon 占位或 innerHTML 场景） */
export function iconSvg(name, size = 16) {
  const d = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">`
    + `<path fill="currentColor" d="${d}"/></svg>`;
}

/** 内联 SVG 元素 */
export function iconEl(name, size = 16) {
  const span = el('span', { class: 'wmc-btn__ic' });
  span.innerHTML = iconSvg(name, size);
  return span;
}

/**
 * 把页面里所有 <... data-wmc-icon="name"> 填成内联 SVG。
 *
 * 好处：HTML 骨架里不必内联一堆重复的 <svg>，图标仍由 JS 集中维护。
 * @returns {number} 实际填充的元素数量（便于自检断言）
 */
export function hydrateIcons(root, size = 16) {
  const scope = root || document;
  let count = 0;
  for (const node of scope.querySelectorAll('[data-wmc-icon]')) {
    node.innerHTML = iconSvg(node.dataset.wmcIcon, size);
    count += 1;
  }
  return count;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 下载量：12345 → "1.2 万"；<1 万显示原值（带千分位） */
export function formatCount(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
  return num.toLocaleString('zh-CN');
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

/** 路径中间省略：C:\\a\\very\\long\\path → C:\\a\\…\\path */
export function middleEllipsis(text, max = 46) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

/** 把多次 DOM 写入合并到下一帧，避免滚动/输入时抖动 */
export function rafBatch(fn) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; fn(); });
  };
}

/** 稳定哈希：用于给分类/封面分配确定性配色 */
export function hashString(str) {
  let h = 2166136261;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

/** 简易睡眠（mock 用） */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));