/**
 * WMC 启动器 · 主进程 IPC 注册（生产实现）
 * ---------------------------------------------------------------------------
 * 架构底线：
 *   · 网络请求（版本清单 / 版本详情）只在主进程发起；
 *   · 文件读取与解压（ZIP / 整合包）只在主进程做；
 *   · 渲染进程一律通过 ipcRenderer.invoke 拿结构化结果，不接触 fs / http。
 *
 * 用法（主进程 app.whenReady() 之后调一次）：
 *   const { registerWmcIpc } = require('./register-ipc.js');
 *   registerWmcIpc({
 *     // 下面这些是可选的「你现有模块」注入点，不传就用内置默认实现
 *     configStore, catalog, javaDetector, downloader, sources, accounts, launcher,
 *     // 必需：游戏目录（用于 versions/ saves 的落盘位置）
 *     gameDir: path.join(app.getPath('userData'), '.minecraft'),
 *   });
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');

const versions = require('./wmc-version-service.js');
const modpack = require('./wmc-modpack-service.js');
const os = require('node:os');

/** 通道名集中在这里，preload 侧保持一一对应（自检脚本会核对两边） */
const CHANNELS = {
  configGet: 'wmc:config:get',
  configPatch: 'wmc:config:patch',
  sourcesList: 'wmc:sources:list',
  sourcesTest: 'wmc:sources:test',
  javaList: 'wmc:java:list',
  systemInfo: 'wmc:system:info',
  catalogCategories: 'wmc:catalog:categories',
  catalogSearch: 'wmc:catalog:search',
  pickDirectory: 'wmc:shell:pick-directory',
  openPath: 'wmc:shell:open',
  downloadStart: 'wmc:download:start',
  downloadCancel: 'wmc:download:cancel',
  downloadProgress: 'wmc:download:progress',
  windowMinimize: 'wmc:window:minimize',
  windowMaximize: 'wmc:window:maximize',
  windowClose: 'wmc:window:close',
  launchGame: 'wmc:game:launch',
  accountGet: 'wmc:account:get',
  worldsRecent: 'wmc:worlds:recent',
  // ---- 本次新增：版本清单 与 整合包拖拽安装 ----
  versionsList: 'wmc:versions:list',
  versionsLatest: 'wmc:versions:latest',
  versionsDetail: 'wmc:versions:detail',
  versionsSources: 'wmc:versions:sources',
  modpackInspect: 'wmc:modpack:inspect',
  modpackInstall: 'wmc:modpack:install',
  modpackPick: 'wmc:modpack:pick',
};

const DEFAULT_SOURCES = [
  { value: 'auto', label: '智能选择', desc: '自动测速' },
  { value: 'bmclapi', label: 'BMCLAPI 镜像', desc: '国内推荐' },
  { value: 'official', label: '官方源', desc: 'Mojang' },
];

function defaultConfig(extra = {}) {
  return {
    javaPath: '',
    maxMemoryMb: 4096,
    minMemoryMb: 1024,
    downloadSource: 'auto',
    downloadThreads: 8,
    gameDir: '',
    verifyDownloads: true,
    // 逻辑底线：没有检测到版本时保持空值，界面显示「没有版本」
    lastVersionId: '',
    versionIsolation: true,
    hideLauncherOnLaunch: false,
    theme: 'paper',
    ...extra,
  };
}

/* ============================================================================
   读写「某世界的 level.dat 时间」等小工具
   ========================================================================== */

function readSaves(gameDir, limit = 3) {
  const savesDir = path.join(gameDir, 'saves');
  if (!fs.existsSync(savesDir)) return [];
  return fs.readdirSync(savesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((dir) => {
      const full = path.join(savesDir, dir.name);
      let lastPlayedMs = 0;
      let sizeBytes = 0;
      try {
        const stat = fs.statSync(full);
        lastPlayedMs = stat.mtimeMs;
      } catch { /* 忽略 */ }
      try {
        // 粗略估算世界体积（level.dat + region）
        sizeBytes = dirSize(full);
      } catch { /* 忽略 */ }
      return {
        name: dir.name,
        dir: full,
        lastPlayed: new Date(lastPlayedMs).toLocaleString('zh-CN'),
        lastPlayedMs,
        sizeBytes,
        version: '',           // 真实版本号要读 level.dat（NBT），留给「存档管理」页做
      };
    })
    .sort((a, b) => b.lastPlayedMs - a.lastPlayedMs)
    .slice(0, limit);
}

function dirSize(dir, depth = 2) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        if (depth > 0) total += dirSize(full, depth - 1);
      } else {
        total += fs.statSync(full).size;
      }
    } catch { /* 忽略不可读项 */ }
  }
  return total;
}

/* ============================================================================
   注册
   ========================================================================== */

function registerWmcIpc(deps = {}) {
  const logger = deps.logger || console;
  const gameDir = deps.gameDir || path.join(app.getPath('userData'), '.minecraft');
  const versionsDir = path.join(gameDir, 'versions');
  let config = defaultConfig({ gameDir, ...deps.initialConfig });

  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);            // 允许热重载时重复注册
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return await fn(event, payload);
      } catch (error) {
        logger.error?.(`[wmc] ${channel} 失败：`, error);
        // 统一成可读错误，渲染层直接展示
        throw new Error(String(error?.message || error));
      }
    });
  };

  /* ------------------------------ 版本清单（真实网络） ------------------------------ */
  // 下拉框分类：release / snapshot / old / fools
  handle(CHANNELS.versionsList, (_event, params = {}) => versions.listVersions({
    source: params.source || 'official',
    category: params.category || 'release',
    query: params.query || '',
    limit: params.limit || 0,
    force: !!params.force,
  }));

  handle(CHANNELS.versionsLatest, (_event, params = {}) => versions.latestVersion({
    source: params.source || 'official',
    category: params.category || 'release',
  }));

  handle(CHANNELS.versionsDetail, (_event, params = {}) => versions.versionDetail(params.id, {
    source: params.source || 'official',
  }));

  handle(CHANNELS.versionsSources, () => versions.sources());

  /* ------------------------------ 整合包拖拽安装 ------------------------------ */
  // 1) 识别（只读）
  handle(CHANNELS.modpackInspect, (_event, { filePath } = {}) => {
    if (!filePath) throw new Error('缺少文件路径');
    return modpack.inspectPack(filePath);
  });

  // 2) 安装：解压进 versions/<隔离名>/ 并写 wmc-pack.json
  handle(CHANNELS.modpackInstall, (_event, params = {}) => modpack.installPack({
    filePath: params.filePath,
    name: params.name,
    overwrite: !!params.overwrite,
    dryRun: !!params.dryRun,
    versionsDir: params.versionsDir || versionsDir,
  }));

  // 3) 兜底入口：从菜单选压缩包（拖拽之外的第二条路）
  handle(CHANNELS.modpackPick, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择整合包',
      properties: ['openFile'],
      filters: [{ name: '整合包', extensions: ['zip', 'mrpack'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return { filePath: result.filePaths[0], report: modpack.inspectPack(result.filePaths[0]) };
  });

  /* ------------------------------ 存档 / 系统 / 账号等（沿用原有契约） ------------------------------ */
  handle(CHANNELS.worldsRecent, (_event, { limit = 3 } = {}) => {
    if (deps.worlds?.recent) return deps.worlds.recent({ limit });
    return readSaves(config.gameDir || gameDir, limit);
  });

  handle(CHANNELS.configGet, async () => {
    if (deps.configStore?.get) return deps.configStore.get();
    return config;
  });

  handle(CHANNELS.configPatch, async (_event, patch = {}) => {
    if (deps.configStore?.patch) return deps.configStore.patch(patch);
    config = { ...config, ...patch };
    return config;
  });

  handle(CHANNELS.sourcesList, async () => (deps.sources?.list ? deps.sources.list() : DEFAULT_SOURCES));

  handle(CHANNELS.sourcesTest, async () => {
    if (deps.sources?.test) return deps.sources.test();
    // 真实测速：对两个官方镜像各发一次请求，量一下延迟
    const targets = [
      { value: 'bmclapi', label: 'BMCLAPI 镜像', url: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json' },
      { value: 'official', label: '官方源', url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' },
    ];
    return Promise.all(targets.map(async (t) => {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(t.url, { redirect: 'follow', signal: controller.signal, method: 'GET' });
        clearTimeout(timer);
        return { value: t.value, label: t.label, latencyMs: res.ok ? Date.now() - started : -1 };
      } catch {
        return { value: t.value, label: t.label, latencyMs: -1 };
      }
    }));
  });

  handle(CHANNELS.javaList, async (_event, { refresh } = {}) => {
    if (deps.javaDetector?.list) return deps.javaDetector.list({ refresh: !!refresh });
    return [];
  });

  handle(CHANNELS.systemInfo, async () => ({
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    arch: os.arch(),
    cpuCount: os.cpus()?.length || 0,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    launcherVersion: app.getVersion(),
    gameDir: config.gameDir || gameDir,
    gameDirWritable: (() => {
      try { fs.accessSync(path.dirname(config.gameDir || gameDir), fs.constants.W_OK); return true; } catch { return false; }
    })(),
    paths: {
      config: path.join(app.getPath('userData'), 'wmc.json'),
      versions: versionsDir,
      saves: path.join(config.gameDir || gameDir, 'saves'),
    },
  }));

  handle(CHANNELS.catalogCategories, async () => (deps.catalog?.categories ? deps.catalog.categories() : []));
  handle(CHANNELS.catalogSearch, async (_event, params = {}) => (deps.catalog?.search
    ? deps.catalog.search(params)
    : { items: [], total: 0, page: params.page || 1, pageSize: params.pageSize || 24, hasMore: false }));

  handle(CHANNELS.pickDirectory, async (event, { initial } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择游戏目录',
      defaultPath: initial || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle(CHANNELS.openPath, async (_event, { path: target } = {}) => {
    if (!target) return false;
    const error = await shell.openPath(target);
    return !error;
  });

  handle(CHANNELS.downloadStart, async (event, item = {}) => {
    if (deps.downloader?.start) {
      const id = `dl-${Date.now().toString(36)}`;
      deps.downloader.start(item, (payload) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(CHANNELS.downloadProgress, { id, itemId: item.id, title: item.title, ...payload });
        }
      });
      return { id };
    }
    return { id: '' };
  });

  handle(CHANNELS.downloadCancel, async (_event, { id } = {}) => (deps.downloader?.cancel ? deps.downloader.cancel(id) : false));

  handle(CHANNELS.windowMinimize, async (event) => { BrowserWindow.fromWebContents(event.sender)?.minimize(); return 'ok'; });
  handle(CHANNELS.windowMaximize, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'ok';
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return 'ok';
  });
  handle(CHANNELS.windowClose, async (event) => { BrowserWindow.fromWebContents(event.sender)?.close(); return 'ok'; });

  handle(CHANNELS.launchGame, async (_event, opts = {}) => {
    if (deps.launcher?.launch) {
      const result = await deps.launcher.launch(opts);
      return { started: true, pid: result?.pid };
    }
    return { started: false, reason: '主进程还没有接入启动模块（launcher.launch）' };
  });

  handle(CHANNELS.accountGet, async () => {
    if (deps.accounts?.current) return deps.accounts.current();
    return {
      id: 'local-default',
      name: '冒险者',
      type: 'offline',
      typeLabel: '离线登录',
      online: false,
      uuid: '00000000000000000000000000000000',
      avatarGlyph: 'W',
      skinModel: 'classic',
      skinUrl: null,
      capeUrl: null,
    };
  });

  logger.info?.('[wmc] 主进程 IPC 已注册（含版本清单与整合包安装）');
  return { channels: CHANNELS, gameDir, versionsDir };
}

module.exports = { registerWmcIpc, CHANNELS, readSaves, defaultConfig };