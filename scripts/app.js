/**
 * WMC 面板 · 预览页装配
 * ---------------------------------------------------------------------------
 * 这个文件演示「如何把两个面板挂到宿主页面」：
 *   - 有 window.wmc（preload 暴露的 IPC）就走真实数据；
 *   - 没有就自动降级到内置模拟数据（因此双击 index.html 也能看到完整效果）。
 * 真实项目里你只需要搬走创建 bridge + mount 的那几行。
 */
import { createBridge } from './wmc-bridge.js';
import { mountDownloadCenter } from './wmc-download-center.js';
import { mountRuntimePanel } from './wmc-runtime-panel.js';
import { toastOk, toastInfo } from './wmc-toast.js';

/** 1) 建桥：forceMock 只在「明确要离线预览」时才传 */
const bridge = createBridge({
  onWarn: (msg) => console.warn(msg),
});

console.info('[WMC 预览] bridge.mode =', bridge.mode, '· namespace =', bridge.namespaceKey || '(无)');

/* ---------------------------------------------------------------- 页签切换 */

const tabs = Array.from(document.querySelectorAll('[data-preview-tab]'));
const slots = {
  'download-center': document.querySelector('[data-preview-slot="download-center"]'),
  runtime: document.querySelector('[data-preview-slot="runtime"]'),
};

const mounted = { 'download-center': null, runtime: null };

async function activate(name) {
  for (const tab of tabs) tab.classList.toggle('is-active', tab.dataset.previewTab === name);
  for (const [key, slot] of Object.entries(slots)) slot.hidden = key !== name;

  if (mounted[name]) return;
  if (name === 'download-center') {
    mounted[name] = await mountDownloadCenter(document.querySelector('[data-wmc-dc]'), {
      bridge,
      pageSize: 24,
      // 宿主可接管「点开卡片」：真实项目里通常是打开资源详情页
      onOpen: (item) => {
        if (globalThis.wmc?.openResource) globalThis.wmc.openResource(item.id);
        else {
          toastInfo(item.title, `${item.sourceLabel} · 作者 ${item.author} · 下载 ${item.downloads.toLocaleString('zh-CN')}`);
        }
      },
    });
  } else {
    mounted[name] = await mountRuntimePanel(document.querySelector('[data-wmc-env]'), {
      bridge,
      onChanged: (config) => toastOk('配置已更新', `最大内存 ${config.maxMemoryMb} MB · 下载源 ${config.downloadSource}`),
    });
  }
}

/**
 * 支持两个 URL 参数，方便深链与自动化截图：
 *   ?panel=runtime           直接打开运行环境面板
 *   ?open=source|sort        打开下载中心的下拉框（用于视觉回归截图）
 */
const params = new URLSearchParams(location.search);
const initialPanel = params.get('panel') === 'runtime' ? 'runtime' : 'download-center';
const openSelect = params.get('open');

for (const tab of tabs) {
  tab.addEventListener('click', () => activate(tab.dataset.previewTab));
}

/* 默认打开下载中心（或 URL 指定的面板） */
activate(initialPanel).then(() => {
  if (openSelect && mounted['download-center']) {
    const handle = mounted['download-center'].debug;
    const select = openSelect === 'sort' ? handle?.sortSelect : handle?.sourceSelect;
    select?.openPanel();
  }
});

/* 把数据来源写到页脚，便于确认当前跑的是 IPC 还是模拟数据 */
const foot = document.querySelector('[data-preview-source]');
if (foot) {
  foot.textContent = bridge.mode === 'ipc'
    ? `数据来源：主进程 IPC（window.${bridge.namespaceKey}）`
    : '数据来源：内置模拟数据（未检测到 window.wmc，属正常现象）';
}

/* 暴露给调试用：可在控制台里 wmcPanel.bridge.provider 查看各能力的来源 */
globalThis.wmcPanel = { bridge, activate, mounted };