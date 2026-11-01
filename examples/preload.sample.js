/**
 * WMC 面板 · preload 参考实现（CommonJS）
 * ---------------------------------------------------------------------------
 * 放到你现有 Electron 项目的 preload 里（或单独 require 进来）。
 *
 * 要点：
 *   1. contextIsolation 必须为 true，且只通过 contextBridge 暴露白名单方法；
 *   2. 暴露到 window 上的名字要与 wmc-bridge.js 的 IPC_MAP.namespace 一致
 *      （默认依次探测 wmc / WMC / electronAPI / api）；
 *   3. 每个方法的**入参形状**要和 wmc-bridge.js 的调用保持一致（见下方注释），
 *      否则改 IPC_MAP 或在这一层做适配即可。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 取「拖拽进来的文件」在磁盘上的路径。
 *
 * ⚠️ Electron 32 起 File.path 已被移除，正确做法是用 webUtils.getPathForFile(file)
 *    （它只在 preload 里可用）。老版本回退到 file.path，再不行就返回空串，
 *    由渲染层走「读成 ArrayBuffer 交给主进程」的兜底分支。
 */
const getDroppedPath = (file) => {
  try {
    if (file && typeof webUtils?.getPathForFile === 'function') return webUtils.getPathForFile(file);
  } catch { /* 忽略，走回退 */ }
  return file?.path || '';
};

/** 统一 invoke 包装：失败时把错误信息整理干净，便于面板 toast 展示 */
const invoke = async (channel, payload) => {
  try {
    return await ipcRenderer.invoke(channel, payload);
  } catch (error) {
    // 主进程抛出的错误会带上前缀，这里只保留可读信息
    throw new Error(String(error?.message || error).replace(/^Error invoking remote method '[^']+':\s*/, ''));
  }
};

contextBridge.exposeInMainWorld('wmc', {
  /* ------------------------------------------------------------ 配置 */
  config: {
    // 入参：无；返回：{ javaPath, maxMemoryMb, minMemoryMb, downloadSource, downloadThreads, gameDir, ... }
    get: () => invoke('wmc:config:get'),
    // 入参：部分配置对象；返回：合并后的完整配置
    patch: (patch) => invoke('wmc:config:patch', patch),
  },

  /* ------------------------------------------------------------ 下载源 */
  sources: {
    // 入参：无；返回：[{ value, label, desc }]
    list: () => invoke('wmc:sources:list'),
    // 入参：无；返回：[{ value, label, latencyMs }]（不可达给 -1）
    test: () => invoke('wmc:sources:test'),
  },

  /* ------------------------------------------------------------ Java */
  java: {
    // 入参：{ refresh?: boolean }；返回：[{ id, name, version, vendor, path, arch, ok, reason? }]
    list: (opts) => invoke('wmc:java:list', opts || {}),
  },

  /* ------------------------------------------------------------ 系统信息 */
  system: {
    // 返回：{ os, arch, cpuCount, totalMemMb, freeMemMb, launcherVersion, gameDir, gameDirWritable, paths }
    info: () => invoke('wmc:system:info'),
  },

  /* ------------------------------------------------------------ 资源目录 */
  catalog: {
    // 返回：[{ id, name, icon, count }]（8 个分类：原版/模组/整合包/数据包/资源包/光影包/地图/服务器插件）
    categories: () => invoke('wmc:catalog:categories'),
    // 入参：{ category, source, query, sort, page, pageSize }
    // 返回：{ items: [...], total, page, pageSize, hasMore }
    // item 形状：{ id, category, title, author, desc, sourceId, sourceLabel, sourceClass,
    //             downloads, tags[], updatedAt, cover, installed, sizeBytes }
    search: (params) => invoke('wmc:catalog:search', params || {}),
  },

  /* ------------------------------------------------------------ 系统交互 */
  shell: {
    // 入参：{ initial?: string }；返回：选中的绝对路径 或 null
    pickDirectory: (opts) => invoke('wmc:shell:pick-directory', opts || {}),
    // 入参：{ path: string }；返回：boolean
    openPath: (opts) => invoke('wmc:shell:open', opts || {}),
  },

  /* ------------------------------------------------------------ 下载 */  download: {
    // 入参：资源对象；返回：{ id }（后续用同一 id 上报进度）
    start: (item) => invoke('wmc:download:start', item),
    // 入参：{ id }；返回：boolean
    cancel: (opts) => invoke('wmc:download:cancel', opts || {}),
    /**
     * 订阅进度。面板的 wmc-bridge.js 会自动识别这种写法。
     * payload: { id, itemId?, title?, progress: 0~1, receivedBytes, totalBytes, speedBytesPerSec?, state? }
     */
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('wmc:download:progress', listener);
      return () => ipcRenderer.removeListener('wmc:download:progress', listener);
    },
  },

  /* ------------------------------------------------------------ 窗口控制 */
  /* 用无边框窗口（frame:false / titleBarStyle:'hidden'）时，顶栏那三个按钮走这里 */
  window: {
    minimize: () => invoke('wmc:window:minimize'),
    maximize: () => invoke('wmc:window:maximize'),
    close: () => invoke('wmc:window:close'),
  },

  /* ------------------------------------------------------------ 启动游戏 */
  game: {
    /**
     * 入参：{ version?: string, account?: string }
     * 返回：{ started: boolean, pid?: number, reason?: string }
     */
    launch: (opts) => invoke('wmc:game:launch', opts || {}),
  },

  /* ------------------------------------------------------------ 账号 */
  account: {
    /**
     * 返回：{ id, name, type: 'offline'|'microsoft'|'littleskin', typeLabel, online,
     *        uuid, avatarGlyph?, skinModel?, skinUrl?, capeUrl? }
     */
    get: () => invoke('wmc:account:get'),
  },

  /* ------------------------------------------------------------ 存档 */
  worlds: {
    /**
     * 入参：{ limit?: number }
     * 返回：[{ name, version, lastPlayed, playtime, sizeBytes, seed, dir }]
     * 主进程读 .minecraft/saves 下各世界的 level.dat（含 LastPlayed / 名称 / 版本）。
     */
    recent: (opts) => invoke('wmc:worlds:recent', opts || {}),
  },

  /* ------------------------------------------------------------ 版本清单（真实网络，主进程发起） */
  versions: {
    /**
     * 入参：{ source?: 'official'|'bmclapi', category?: 'release'|'snapshot'|'old'|'fools',
     *        query?: string, limit?: number, force?: boolean }
     * 返回：{ source, sourceLabel, fromCache, fallback, latest:{release,snapshot},
     *        categories, total, counts, items:[{id,type,category,releaseTime,time,url,sha1}] }
     */
    list: (opts) => invoke('wmc:versions:list', opts || {}),
    /** 顶部大卡片用：最新正式版（category 可选 snapshot） */
    latest: (opts) => invoke('wmc:versions:latest', opts || {}),
    /** 安装时用：某个版本的详细信息（mainClass / 资源索引 / Java 要求 / 库数量） */
    detail: (opts) => invoke('wmc:versions:detail', opts || {}),
    /** 可用下载源：[{ value, label }] */
    sources: () => invoke('wmc:versions:sources'),
  },

  /* ------------------------------------------------------------ 整合包拖拽安装（主进程解压） */
  modpack: {
    /** 识别：入参 { filePath }，返回 { ok, kind, label, evidence, meta, file, topLevel } */
    inspect: (opts) => invoke('wmc:modpack:inspect', opts || {}),
    /** 安装：入参 { filePath, name?, overwrite?, dryRun? }，返回 { isolation, targetDir, extracted, skipped, marker } */
    install: (opts) => invoke('wmc:modpack:install', opts || {}),
    /** 兜底入口：弹系统文件选择框挑整合包 */
    pick: () => invoke('wmc:modpack:pick'),
    /** 把拖拽的 File 对象转成磁盘路径（Electron 32+ 必须走 webUtils） */
    pathOf: (file) => getDroppedPath(file),
  },
});