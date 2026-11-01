/**
 * WMC 面板 · 渲染层 ↔ Electron 主进程 适配层
 * ---------------------------------------------------------------------------
 * 设计目标：**面板代码不关心你的 IPC 叫什么名字**。
 *   - 若渲染层存在 window.wmc / window.electronAPI / window.api（按 IPC_MAP.namespace 顺序探测），
 *     优先走真实 IPC；
 *   - 任何一个能力在 IPC 上缺失或报错，就自动降级到内置 mock，并在 console 记录，
 *     因此「面板能跑起来」永远优先于「接口必须齐全」；
 *   - 所有差异集中在下面的 IPC_MAP，你只需要改这一处。

 * 需要的接口（名字随便，改 IPC_MAP 即可）：
 *   config.get / config.patch
 *   sources.list / sources.test
 *   java.list
 *   system.info
 *   catalog.categories / catalog.search
 *   shell.pickDirectory / shell.openPath
 *   download.start / download.cancel  +  事件 download:progress
 */
import {
  mockAccount, mockCategories, mockConfig, mockFortune, mockJavaList, mockQuickEntries,
  mockRecommended, mockRecentWorlds, mockSearch, mockSorts, mockSourceLatency, mockSources, mockSystemInfo,
} from './wmc-mock-data.js';
import { sleep } from './wmc-dom.js';

export const IPC_MAP = {
  /** 依次探测的全局对象名（preload 里 contextBridge.exposeInMainWorld 的名字） */
  namespace: ['wmc', 'WMC', 'electronAPI', 'api'],

  /** 方法路径：既支持嵌套（wmc.config.get），也支持扁平（wmc.configGet） */
  methods: {
    configGet: ['config.get', 'getConfig', 'configGet'],
    configPatch: ['config.patch', 'setConfig', 'configPatch'],
    sources: ['sources.list', 'getSources', 'listSources'],
    sourceTest: ['sources.test', 'testSources', 'speedTest'],
    javaList: ['java.list', 'listJava', 'detectJava'],
    systemInfo: ['system.info', 'getSystemInfo', 'systemInfo'],
    categories: ['catalog.categories', 'getCategories'],
    search: ['catalog.search', 'searchResources'],
    pickDirectory: ['shell.pickDirectory', 'selectDirectory', 'chooseDirectory'],
    openPath: ['shell.openPath', 'openPath', 'revealPath'],
    downloadStart: ['download.start', 'startDownload'],
    downloadCancel: ['download.cancel', 'cancelDownload'],
    windowMinimize: ['window.minimize', 'minimize'],
    windowMaximize: ['window.maximize', 'toggleMaximize'],
    windowClose: ['window.close', 'closeWindow'],
    launchGame: ['game.launch', 'launchGame'],
    accountGet: ['account.get', 'getAccount'],
    recentWorlds: ['worlds.recent', 'getRecentWorlds'],
    // ---- 版本清单（真实网络，只在主进程发起）----
    versionsList: ['versions.list', 'listVersions'],
    versionsLatest: ['versions.latest', 'latestVersion'],
    versionsDetail: ['versions.detail', 'versionDetail'],
    versionsSources: ['versions.sources', 'getVersionSources'],
    // ---- 整合包（主进程读文件 / 解压）----
    modpackInspect: ['modpack.inspect', 'inspectModpack', 'inspectPack'],
    modpackInstall: ['modpack.install', 'installModpack', 'installPack'],
    modpackPick: ['modpack.pick', 'pickModpack'],
    modpackPathOf: ['modpack.pathOf', 'pathOf', 'getPathForFile'],
  },

  /** 若 preload 只暴露了 ipcRenderer.invoke，用这些 channel 名兜底 */
  channels: {
    configGet: 'wmc:config:get',
    configPatch: 'wmc:config:patch',
    sources: 'wmc:sources:list',
    sourceTest: 'wmc:sources:test',
    javaList: 'wmc:java:list',
    systemInfo: 'wmc:system:info',
    categories: 'wmc:catalog:categories',
    search: 'wmc:catalog:search',
    pickDirectory: 'wmc:shell:pick-directory',
    openPath: 'wmc:shell:open',
    downloadStart: 'wmc:download:start',
    downloadCancel: 'wmc:download:cancel',
    windowMinimize: 'wmc:window:minimize',
    windowMaximize: 'wmc:window:maximize',
    windowClose: 'wmc:window:close',
    launchGame: 'wmc:game:launch',
    accountGet: 'wmc:account:get',
    recentWorlds: 'wmc:worlds:recent',
    versionsList: 'wmc:versions:list',
    versionsLatest: 'wmc:versions:latest',
    versionsDetail: 'wmc:versions:detail',
    versionsSources: 'wmc:versions:sources',
    modpackInspect: 'wmc:modpack:inspect',
    modpackInstall: 'wmc:modpack:install',
    modpackPick: 'wmc:modpack:pick',
  },

  /** 事件通道 */
  events: {
    downloadProgress: ['download:progress', 'wmc:download:progress'],
  },

  /** mock 时模拟的网络延迟区间（毫秒），让骨架屏与加载态真的能被看到 */
  mockLatency: { search: [280, 700], small: [90, 260], download: [40, 160] },
};

/* ------------------------------------------------------------------ 工具 */

const randBetween = ([min, max]) => min + Math.random() * (max - min);

function findNamespace() {
  for (const key of IPC_MAP.namespace) {
    const ns = globalThis[key];
    if (ns && typeof ns === 'object') return { ns, key };
  }
  return { ns: null, key: null };
}

function resolveMethod(ns, paths) {
  for (const path of [].concat(paths)) {
    let cur = ns;
    let ok = true;
    for (const part of path.split('.')) {
      if (cur == null || typeof cur !== 'object') { ok = false; break; }
      cur = cur[part];
    }
    if (ok && typeof cur === 'function') return cur.bind(ns);
  }
  return null;
}

/* ------------------------------------------------------------------ 桥接主体 */

/**
 * @param {object} [opts]
 * @param {boolean} [opts.forceMock] 强制走 mock（预览页/单测用）
 * @param {(msg:string)=>void} [opts.onWarn] 降级时的回调（默认 console.warn）
 */
export function createBridge(opts = {}) {
  const warned = new Set();
  const warn = (msg) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    (opts.onWarn || console.warn)(`[WMC 面板] ${msg}`);
  };

  const { ns, key } = opts.forceMock ? { ns: null, key: null } : findNamespace();
  const hasIpc = !!ns;
  const invoke = ns && typeof ns.invoke === 'function' ? ns.invoke.bind(ns) : null;

  /** 记录每个能力最终由谁提供，便于调试与「接口自检」 */
  const provider = {};
  const latency = IPC_MAP.mockLatency;

  /**
   * 统一的调用封装：IPC 优先 → 失败/缺失则 mock 兜底。
   * @param {string} capability IPC_MAP.methods 的键
   * @param {any} payload
   * @param {() => any} mockFactory
   */
  async function call(capability, payload, mockFactory) {
    if (ns) {
      const method = resolveMethod(ns, IPC_MAP.methods[capability] || []);
      try {
        if (method) {
          const result = await method(payload);
          provider[capability] = 'ipc';
          return result;
        }
        if (invoke && IPC_MAP.channels[capability]) {
          const result = await invoke(IPC_MAP.channels[capability], payload);
          provider[capability] = 'ipc';
          return result;
        }
      } catch (error) {
        warn(`IPC 调用 ${capability} 失败，已降级到模拟数据：${error?.message || error}`);
        provider[capability] = 'mock(fallback)';
        await sleep(randBetween(latency.small));
        return mockFactory();
      }
    }
    provider[capability] = 'mock';
    await sleep(randBetween(capability === 'search' ? latency.search : latency.small));
    return mockFactory();
  }

  /**
   * 严格调用：**只走主进程，绝不回退到假数据**。
   *
   * 「游戏下载」的版本清单与「整合包拖拽安装」必须使用真实网络与真实文件操作，
   * 因此这两类能力在缺少 IPC（浏览器预览 / preload 没暴露）时直接抛错，
   * 由页面显示红色的「需要 Electron 主进程」提示。
   */
  async function strictCall(capability, payload) {
    if (!ns) {
      provider[capability] = 'unavailable';
      const error = new Error('需要 Electron 主进程：版本清单与整合包安装不提供离线数据');
      error.code = 'NO_IPC';
      throw error;
    }
    const method = resolveMethod(ns, IPC_MAP.methods[capability] || []);
    if (method) {
      const result = await method(payload);
      provider[capability] = 'ipc';
      return result;
    }
    if (invoke && IPC_MAP.channels[capability]) {
      const result = await invoke(IPC_MAP.channels[capability], payload);
      provider[capability] = 'ipc';
      return result;
    }
    provider[capability] = 'unavailable';
    const error = new Error(`preload 未暴露 ${capability}（请更新 preload.js）`);
    error.code = 'NO_METHOD';
    throw error;
  }

  /** 把拖拽的 File 转成磁盘路径：优先 preload 的 webUtils 版本 */
  function filePathOf(file) {
    const method = ns ? resolveMethod(ns, IPC_MAP.methods.modpackPathOf || []) : null;
    if (method) {
      try {
        const result = method(file);
        if (result) return result;
      } catch { /* 回退 */ }
    }
    return (file && typeof file.path === 'string') ? file.path : '';
  }

  /* ---------------------------------------------------------------- 事件 */

  const progressListeners = new Set();
  let ipcProgressBound = false;

  function bindIpcProgress() {
    if (ipcProgressBound || !ns) return;
    ipcProgressBound = true;
    const channels = IPC_MAP.events.downloadProgress;
    // 依次尝试四种常见暴露方式（取第一个可用的）：
    //   1) wmc.on(channel, cb)
    //   2) wmc.events.on(channel, cb)
    //   3) wmc.download.onProgress(cb)   ← preload 里最常见、最省事的一种
    //   4) wmc.addEventListener(channel, cb)
    const subscribe = (typeof ns.on === 'function' ? ns.on.bind(ns) : null)
      || (ns.events && typeof ns.events.on === 'function' ? ns.events.on.bind(ns.events) : null)
      || (ns.download && typeof ns.download.onProgress === 'function'
        ? (_channel, cb) => ns.download.onProgress(cb) : null)
      || (typeof ns.addEventListener === 'function' ? ns.addEventListener.bind(ns) : null);
    if (!subscribe) return;
    for (const channel of channels) {
      try {
        subscribe(channel, (payload) => {
          for (const fn of progressListeners) fn(payload);
        });
      } catch {
        /* 该通道不存在就忽略 */
      }
    }
  }

  /* ---------------------------------------------------------------- 模拟下载 */

  const mockDownloads = new Map();
  let mockDownloadSeq = 0;

  function startMockDownload(item) {
    const id = `mock-dl-${(mockDownloadSeq += 1)}`;
    const total = item?.sizeBytes || 42_000_000;
    const state = { id, progress: 0, cancelled: false };
    mockDownloads.set(id, state);

    const tick = async () => {
      while (state.progress < 1 && !state.cancelled) {
        await sleep(randBetween(latency.download) + 90);
        state.progress = Math.min(1, state.progress + 0.04 + Math.random() * 0.08);
        const payload = {
          id, itemId: item?.id, title: item?.title,
          progress: state.progress,
          receivedBytes: Math.round(total * state.progress),
          totalBytes: total,
          speedBytesPerSec: Math.round(1_600_000 + Math.random() * 2_400_000),
          state: state.progress >= 1 ? 'done' : 'downloading',
        };
        for (const fn of progressListeners) fn(payload);
      }
      mockDownloads.delete(id);
    };
    tick();
    return { id };
  }

  /* ---------------------------------------------------------------- API */

  const api = {
    /** 'ipc' | 'mock' */
    get mode() {
      return hasIpc ? 'ipc' : 'mock';
    },
    /** 探测到的命名空间名（调试用） */
    get namespaceKey() {
      return key;
    },
    /** 每个能力实际由谁提供 */
    get provider() {
      return { ...provider };
    },

    /* ---------------- 目录/搜索 ---------------- */
    categories: () => call('categories', undefined, mockCategories),

    search: (params) => call('search', params, () => mockSearch(params)),

    sorts: async () => mockSorts(),

    /* ---------------- 下载源 ---------------- */
    sources: () => call('sources', undefined, mockSources),

    testSources: () => call('sourceTest', undefined, mockSourceLatency),

    /* ---------------- 环境 ---------------- */
    javaList: (refresh = false) => call('javaList', { refresh }, () => mockJavaList(refresh)),

    systemInfo: () => call('systemInfo', undefined, mockSystemInfo),

    configGet: () => call('configGet', undefined, mockConfig),

    configPatch: (partial) => call('configPatch', partial, () => ({ ...mockConfig(), ...partial })),

    /* ---------------- 系统交互 ---------------- */
    pickDirectory: (initial) => call('pickDirectory', { initial }, () => mockPickDirectory(initial)),

    openPath: (target) => call('openPath', { path: target }, () => true),

    /* ---------------- 账号（导航用户组件 / 账户中心） ---------------- */
    account: () => call('accountGet', undefined, mockAccount),

    /* ---------------- 首页数据 ---------------- */
    quickEntries: async () => mockQuickEntries(),
    recommended: (count = 4) => call('search', { category: 'mod', sort: 'popular', page: 1, pageSize: count },
      () => mockRecommended(count)),
    fortune: async () => mockFortune(),
    /** 存档速览：最近玩过的世界（主进程读 saves 目录，无则回退示例数据） */
    recentWorlds: (limit = 3) => call('recentWorlds', { limit }, () => mockRecentWorlds().slice(0, limit)),

    /* ---------------- 窗口控制（无边框窗口用） ---------------- */
    windowControls: {
      minimize: () => call('windowMinimize', undefined, () => 'mock'),
      maximize: () => call('windowMaximize', undefined, () => 'mock'),
      close: () => call('windowClose', undefined, () => 'mock'),
    },

    /* ---------------- 启动游戏 ---------------- */
    /** 有主进程就交给它启动；否则返回 mock，让界面给出明确提示 */
    launchGame: (options) => call('launchGame', options, () => ({ started: false, reason: 'mock' })),

    /* ---------------- 版本清单（真实网络，主进程发起；无 IPC 直接报错） ---------------- */
    versionsList: (options = {}) => strictCall('versionsList', options),
    versionsLatest: (options = {}) => strictCall('versionsLatest', options),
    versionsDetail: (options = {}) => strictCall('versionsDetail', options),
    versionsSources: () => strictCall('versionsSources', undefined),

    /* ---------------- 整合包（主进程读文件 / 解压；无 IPC 直接报错） ---------------- */
    modpackInspect: (filePath) => strictCall('modpackInspect', { filePath }),
    modpackInstall: (options = {}) => strictCall('modpackInstall', options),
    modpackPick: () => strictCall('modpackPick', undefined),
    /** 拖拽 File → 磁盘路径（Electron 32+ 走 webUtils.getPathForFile） */
    filePathOf,

    /* ---------------- 下载 ---------------- */
    startDownload: (item) => call('downloadStart', item, () => startMockDownload(item)),

    cancelDownload: (id) => call('downloadCancel', { id }, () => {
      const state = mockDownloads.get(id);
      if (state) state.cancelled = true;
      return true;
    }),

    /** 订阅下载进度，返回解绑函数 */
    onProgress(fn) {
      progressListeners.add(fn);
      bindIpcProgress();
      return () => progressListeners.delete(fn);
    },
  };

  return api;
}

/** 预览页里「选择目录」：不需要真的弹系统对话框 */
function mockPickDirectory(initial) {
  const base = initial || 'C:\\Users\\Public\\Documents\\WMC\\.minecraft';
  return `${base}${base.endsWith('\\') ? '' : '\\'}versions`;
}

export default createBridge;