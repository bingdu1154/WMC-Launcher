/**
 * WMC · 应用引导（app.html 用）
 * ---------------------------------------------------------------------------
 * 装配顺序：建桥 → 填图标 → 建外壳 → 注册页面 → 进入首页。
 * 真实项目里把这几步放进你的渲染层入口即可（Vue/React 也能照抄这段逻辑）。
 */
import { createBridge } from './wmc-bridge.js';
import { mountGlobalDrop } from './wmc-dragdrop.js';
import { hydrateIcons } from './wmc-dom.js';
import { mountGameDownload } from './wmc-game-download.js';
import { mountHome } from './wmc-home.js';
import { createShell, PAGE_META } from './wmc-shell.js';

/* 1) 建桥：有 window.wmc 走主进程 IPC，没有就自动用模拟数据（方便离线预览） */
const bridge = createBridge({ onWarn: (msg) => console.warn(msg) });
console.info('[WMC] bridge.mode =', bridge.mode, '· namespace =', bridge.namespaceKey || '(无)');

/* 2) HTML 里只写 <span data-wmc-icon="gear">，图标由这里统一注入 */
const appRoot = document.querySelector('[data-wmc-app]');
const iconCount = hydrateIcons(appRoot);

/* 3) 外壳：导航 / 顶部栏 / 路由 */
const shell = createShell(appRoot, {
  bridge,
  // 顶部搜索回车时触发（任务 3 会跳转到模组下载页并带上关键词）
  onSearch: (keyword) => console.info('[WMC] 全局搜索:', keyword),
  // 左下角用户组件点击（任务 5 会换成账户中心弹窗）
  onUserClick: null,
});

/* 4) 注册页面：每个页面从自己的 <template> 克隆骨架，来回切页都是干净状态。 */
shell.addPage('home', (host, api) => {
  const template = document.querySelector('[data-wmc-template="home"]');
  if (!template) throw new Error('缺少首页模板 [data-wmc-template="home"]');
  host.replaceChildren(template.content.cloneNode(true));
  return mountHome(host, { bridge, shell: api });
});

// 游戏下载（原版版本）：数据全部来自主进程真实接口
shell.addPage('game', (host, api) => {
  const template = document.querySelector('[data-wmc-template="game"]');
  if (!template) throw new Error('缺少游戏下载页模板 [data-wmc-template="game"]');
  host.replaceChildren(template.content.cloneNode(true));
  return mountGameDownload(host, { bridge, shell: api });
});

// 任务 3：shell.addPage('mod', ...) / addPage('modpack', ...) / addPage('resourcepack', ...)
// 任务 4：shell.addPage('settings', (host, api) => mountSettings(host, { bridge, shell: api }));

/* 5) 全局拖拽安装：挂在窗口上一份，所有页面都能拖入 .zip / .mrpack */
const dropzone = mountGlobalDrop({
  bridge,
  onInstalled: (result) => console.info('[WMC] 整合包已安装到', result.targetDir),
});

/* 6) 进入起始页：支持 ?page=game 这类深链（路由跳转、截图自动化都用得上） */
const requested = new URLSearchParams(location.search).get('page');
const initialPage = requested && PAGE_META[requested] ? requested : 'home';
await shell.navigate(initialPage);

/* 调试句柄：控制台里可看 wmcShell.bridge.provider（各能力由 IPC 还是 mock 提供） */
globalThis.wmcShell = { bridge, shell, iconCount, initialPage, dropzone };