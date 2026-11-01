/**
 * WMC 面板 · 主进程 IPC 参考实现（CommonJS）
 * ---------------------------------------------------------------------------
 * 用法：在你现有 Electron 主进程里注册一次即可：
 *
 *   const { registerWmcHandlers } = require('./main-handlers.sample.js');
 *   registerWmcHandlers({
 *     configStore: 你现有的配置读写模块,   // get() / patch(obj)
 *     catalog:     你现有的资源目录模块,   // categories() / search(params)
 *     javaDetector:你现有的 Java 检测模块, // list({ refresh })
 *     downloader:  你现有的下载队列模块,   // start(item, onProgress) / cancel(id)
 *     sources:     你现有的下载源模块,     // list() / test()
 *   });
 *
 * 每个依赖都是可选的：没传的会用默认实现（保证面板不会因为缺接口而白屏）。
 */
const { ipcMain, dialog, shell, app } = require('electron');

/** 简单的延迟，避免 mock 分支返回过快导致前端的加载态一闪而过 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 默认实现 */

const DEFAULT_SOURCES = [
  { value: 'auto', label: '智能选择', desc: '自动测速' },
  { value: 'bmclapi', label: 'BMCLAPI 镜像', desc: '国内推荐' },
  { value: 'official', label: '官方源', desc: 'Mojang' },
  { value: 'curseforge', label: 'CurseForge 源', desc: '模组直连' },
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
    ...extra,
  };
}

/* ------------------------------------------------------------------ 注册 */

function registerWmcHandlers(deps = {}) {
  const {
    configStore, catalog, javaDetector, downloader, sources, logger = console,
  } = deps;

  let config = defaultConfig(deps.initialConfig);

  /* --------------------------- 配置 --------------------------- */
  ipcMain.handle('wmc:config:get', async () => {
    if (configStore?.get) return configStore.get();
    return config;
  });

  ipcMain.handle('wmc:config:patch', async (_event, patch = {}) => {
    if (configStore?.patch) return configStore.patch(patch);
    config = { ...config, ...patch };
    logger.info?.('[wmc] 配置已更新:', Object.keys(patch));
    return config;
  });

  /* --------------------------- 下载源 --------------------------- */
  ipcMain.handle('wmc:sources:list', async () => {
    if (sources?.list) return sources.list();
    return DEFAULT_SOURCES;
  });

  ipcMain.handle('wmc:sources:test', async () => {
    if (sources?.test) return sources.test();
    // 没有测速实现时返回 -1（面板会显示为「不可达」，提示用户切换）
    await sleep(400);
    return DEFAULT_SOURCES.map((s) => ({ ...s, latencyMs: s.value === 'auto' ? 0 : -1 }));
  });

  /* --------------------------- Java --------------------------- */
  ipcMain.handle('wmc:java:list', async (_event, { refresh } = {}) => {
    if (javaDetector?.list) return javaDetector.list({ refresh: !!refresh });
    await sleep(refresh ? 600 : 120);
    return [];
  });

  /* --------------------------- 系统信息 --------------------------- */
  ipcMain.handle('wmc:system:info', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const gameDir = config.gameDir || path.join(app.getPath('userData'), '.minecraft');
    let gameDirWritable = true;
    try {
      require('node:fs').accessSync(path.dirname(gameDir), require('node:fs').constants.W_OK);
    } catch {
      gameDirWritable = false;
    }
    return {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      arch: os.arch(),
      cpuCount: os.cpus()?.length || 0,
      totalMemMb: Math.round(os.totalmem() / 1048576),
      freeMemMb: Math.round(os.freemem() / 1048576),
      launcherVersion: app.getVersion(),
      gameDir,
      gameDirWritable,
      paths: {
        config: path.join(app.getPath('userData'), 'wmc.json'),
        logs: path.join(app.getPath('logs') || app.getPath('userData'), 'wmc.log'),
      },
    };
  });

  /* --------------------------- 资源目录 --------------------------- */
  ipcMain.handle('wmc:catalog:categories', async () => {
    if (catalog?.categories) return catalog.categories();
    return [
      { id: 'vanilla', name: '原版', icon: '🪶', count: 0 },
      { id: 'mod', name: '模组', icon: '🧩', count: 0 },
      { id: 'modpack', name: '整合包', icon: '📦', count: 0 },
      { id: 'datapack', name: '数据包', icon: '📜', count: 0 },
      { id: 'resourcepack', name: '资源包', icon: '🎨', count: 0 },
      { id: 'shader', name: '光影包', icon: '🌅', count: 0 },
      { id: 'map', name: '地图', icon: '🗺', count: 0 },
      { id: 'plugin', name: '服务器插件', icon: '⚙', count: 0 },
    ];
  });

  ipcMain.handle('wmc:catalog:search', async (_event, params = {}) => {
    if (catalog?.search) return catalog.search(params);
    // 接上你现有的「CurseForge / Modrinth / 官方」聚合搜索即可
    await sleep(260);
    return {
      items: [], total: 0, page: params.page || 1,
      pageSize: params.pageSize || 24, hasMore: false,
    };
  });

  /* --------------------------- 系统交互 --------------------------- */
  ipcMain.handle('wmc:shell:pick-directory', async (event, { initial } = {}) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择游戏目录',
      defaultPath: initial || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('wmc:shell:open', async (_event, { path: target } = {}) => {
    if (!target) return false;
    const error = await shell.openPath(target);
    if (error) {
      logger.warn?.('[wmc] 打开目录失败:', error);
      return false;
    }
    return true;
  });

  /* --------------------------- 下载 --------------------------- */
  ipcMain.handle('wmc:download:start', async (event, item = {}) => {
    const sender = event.sender;
    const id = `dl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;

    if (downloader?.start) {
      // 把你现有下载队列的进度回调桥接到渲染层
      downloader.start(item, (payload) => {
        if (!sender.isDestroyed()) {
          sender.send('wmc:download:progress', { id, itemId: item.id, title: item.title, ...payload });
        }
      });
      return { id };
    }

    // 没有下载器时：用一个可见的假进度，便于先把界面联调通
    let progress = 0;
    const total = item.sizeBytes || 42_000_000;
    const timer = setInterval(() => {
      progress = Math.min(1, progress + 0.05 + Math.random() * 0.1);
      if (!sender.isDestroyed()) {
        sender.send('wmc:download:progress', {
          id, itemId: item.id, title: item.title, progress,
          receivedBytes: Math.round(total * progress), totalBytes: total, state: progress >= 1 ? 'done' : 'downloading',
        });
      }
      if (progress >= 1) clearInterval(timer);
    }, 220);
    return { id };
  });

  ipcMain.handle('wmc:download:cancel', async (_event, { id } = {}) => {
    if (downloader?.cancel) return downloader.cancel(id);
    return true;
  });

  /* --------------------------- 窗口控制 --------------------------- */
  const windowOf = (event) => require('electron').BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('wmc:window:minimize', async (event) => {
    windowOf(event)?.minimize();
    return 'ok';
  });

  ipcMain.handle('wmc:window:maximize', async (event) => {
    const win = windowOf(event);
    if (!win) return 'ok';
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return 'ok';
  });

  ipcMain.handle('wmc:window:close', async (event) => {
    windowOf(event)?.close();
    return 'ok';
  });

  /* --------------------------- 启动游戏 --------------------------- */
  ipcMain.handle('wmc:game:launch', async (_event, opts = {}) => {
    if (launcher?.launch) {
      // 把你现有的启动流程接进来：校验 Java → 补全文件 → 拉起进程
      const result = await launcher.launch(opts);
      return { started: true, pid: result?.pid };
    }
    logger.info?.('[wmc] 收到启动请求（尚未接入启动器模块）:', opts);
    return { started: false, reason: '主进程还没有接入启动模块（launcher.launch）' };
  });

  /* --------------------------- 账号 --------------------------- */
  ipcMain.handle('wmc:account:get', async () => {
    if (accounts?.current) return accounts.current();
    // 默认返回离线账号，保证导航左下角用户组件不会空着
    return {
      id: 'local-default',
      name: '冒险者',
      type: 'offline',
      typeLabel: '离线登录',
      online: false,
      uuid: 'c0a1b2c3d4e5f60718293a4b5c6d7e8f',
      avatarGlyph: 'W',
      skinModel: 'classic',
      skinUrl: null,
      capeUrl: null,
    };
  });

  /* --------------------------- 存档速览 --------------------------- */
  ipcMain.handle('wmc:worlds:recent', async (_event, { limit = 3 } = {}) => {
    if (worlds?.recent) return worlds.recent({ limit });
    // 参考实现：读 saves 目录，按 level.dat 的 LastPlayed 排序取最近 N 个
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const savesDir = path.join(config.gameDir || app.getPath('userData'), 'saves');
      if (!fs.existsSync(savesDir)) return [];
      const entries = fs.readdirSync(savesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      const list = entries.map((dir) => {
        const full = path.join(savesDir, dir.name);
        const levelDat = path.join(full, 'level.dat');
        let lastPlayed = 0;
        try { lastPlayed = fs.statSync(levelDat).mtimeMs; } catch { /* 忽略无 level.dat 的目录 */ }
        return {
          name: dir.name,
          dir: full,
          lastPlayed: new Date(lastPlayed).toLocaleString('zh-CN'),
          lastPlayedMs: lastPlayed,
          sizeBytes: 0,
          version: '',
        };
      }).sort((a, b) => b.lastPlayedMs - a.lastPlayedMs).slice(0, limit);
      logger.info?.(`[wmc] 存档速览：读取到 ${list.length} 个最近世界`);
      return list;
    } catch (error) {
      logger.warn?.('[wmc] 读取存档失败:', error);
      return [];
    }
  });

  logger.info?.('[wmc] 面板 IPC 已注册');
}

module.exports = { registerWmcHandlers, DEFAULT_SOURCES, defaultConfig };