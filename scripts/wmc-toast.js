/**
 * WMC 面板 · Toast 浮层
 * ---------------------------------------------------------------------------
 * 固定右下角，宣纸卡片 + 金边，自动淡出。挂载点自身带 .wmc-scope 以便继承设计令牌。
 */
import { el } from './wmc-dom.js';

let host = null;

/** 懒创建宿主（放在 body 上，不受任何面板容器 overflow 影响） */
function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = el('div', { class: 'wmc-toasts wmc-scope', attrs: { role: 'status', 'aria-live': 'polite' } });
  document.body.append(host);
  return host;
}

/**
 * 弹出一条提示。
 * @param {{kind?: 'info'|'ok'|'err', title: string, body?: string, duration?: number}} opts
 */
export function toast({ kind = 'info', title, body = '', duration = 3200 }) {
  const root = ensureHost();
  const cls = ['wmc-toast'];
  if (kind === 'ok') cls.push('wmc-toast--ok');
  if (kind === 'err') cls.push('wmc-toast--err');

  const node = el('div', { class: cls.join(' ') }, [
    el('div', { class: 'wmc-toast__title', text: title }),
    body ? el('div', { class: 'wmc-toast__body', text: body }) : null,
  ]);

  root.append(node);
  // 最多同时显示 4 条，超出移除最早的
  while (root.children.length > 4) root.firstElementChild.remove();

  const life = Math.max(1200, duration);
  const timer = setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 260);
  }, life);

  node.addEventListener('click', () => { clearTimeout(timer); node.remove(); });
  return node;
}

export const toastOk = (title, body) => toast({ kind: 'ok', title, body });
export const toastErr = (title, body) => toast({ kind: 'err', title, body, duration: 5200 });
export const toastInfo = (title, body) => toast({ kind: 'info', title, body });

/** 清空（切换页面/卸载时用） */
export function clearToasts() {
  if (host) host.replaceChildren();
}