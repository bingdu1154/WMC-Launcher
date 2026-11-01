/**
 * WMC 启动器 · 版本服务（主进程，真实网络）
 * ---------------------------------------------------------------------------
 * 架构底线：所有网络请求都在主进程完成，渲染进程只通过 IPC 拿结果。
 * 事实依据（本机已实测）：
 *   · 官方源   https://piston-meta.mojang.com/mc/game/version_manifest_v2.json   → 200
 *   · BMCLAPI  https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json  → 302 跳到签名 CDN，
 *              所以必须允许跟随重定向（fetch 默认 follow，这里显式写出来）。
 *   · 2026-11-01 实测：921 个版本 { release:103, snapshot:757, old_beta:26, old_alpha:35 }，
 *              latest = { release: '26.3', snapshot: '26.4-snapshot-6' }。
 *
 * 本文件不依赖任何第三方库；纯函数与网络分离，便于单测（自检脚本会直接测 normalize / filter）。
 */
'use strict';

const SOURCES = [
  {
    id: 'official',
    label: 'Mojang 官方源',
    manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    assets: 'https://resources.download.minecraft.net',
    libraries: 'https://libraries.minecraft.net',
  },
  {
    id: 'bmclapi',
    label: 'BMCLAPI 镜像（国内推荐）',
    manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    assets: 'https://bmclapi2.bangbang93.com/assets',
    libraries: 'https://bmclapi2.bangbang93.com/maven',
  },
];

/**
 * 愚人节版本（社区整理 + 已对真实清单逐条核对，大小写不敏感）：
 *   15w14a / 1.RV-Pre1 / 3D Shareware v1.34 / 20w14infinite
 *   22w13oneblockatatime / 23w13a_or_b / 24w14potato / 25w14craftmine
 */
const FOOLS_IDS = [
  '15w14a',
  '1.rv-pre1',
  '3d shareware v1.34',
  '20w14infinite',
  '22w13oneblockatatime',
  '23w13a_or_b',
  '24w14potato',
  '25w14craftmine',
];

/** 有的清单里 id 大小写不一致，统一小写比较 */
const FOOLS_PATTERN = /(oneblock|craftmine|potato|shareware|infinite|_or_b|rv-pre)/i;

/** 版本分类（下载页下拉框的四项） */
const CATEGORIES = [
  { id: 'release', label: '正式版', en: 'RELEASE' },
  { id: 'snapshot', label: '预览版', en: 'SNAPSHOT' },
  { id: 'old', label: '远古版', en: 'OLD' },
  { id: 'fools', label: '愚人节版', en: 'FOOLS' },
];

const DEFAULTS = {
  cacheTtlMs: 10 * 60 * 1000,   // 清单缓存 10 分钟
  timeoutMs: 20000,
};

/* ============================================================================
   纯函数：清单规范化 / 分类 / 过滤
   ========================================================================== */

/**
 * 把原始 manifest 规范化成启动器内部结构。
 * @param {object} raw Mojang 格式的 manifest
 * @returns {{latest:{release:string,snapshot:string}, versions:Array}}
 */
function normalizeManifest(raw) {
  if (!raw || !Array.isArray(raw.versions)) {
    throw new Error('版本清单格式不正确（缺少 versions 数组）');
  }
  return {
    latest: {
      release: String(raw.latest?.release || ''),
      snapshot: String(raw.latest?.snapshot || ''),
    },
    versions: raw.versions.map((v) => ({
      id: String(v.id || ''),
      type: String(v.type || 'unknown'),
      url: String(v.url || ''),
      sha1: String(v.sha1 || ''),
      releaseTime: String(v.releaseTime || ''),
      time: String(v.time || ''),
      complianceLevel: Number(v.complianceLevel) || 0,
      category: classifyVersion(v.type, v.id),
    })).filter((v) => v.id),
  };
}

/** 判定版本归类：release / snapshot / old / fools（愚人节优先，因为它们是 snapshot 类型） */
function classifyVersion(type, id) {
  const lower = String(id || '').toLowerCase();
  if (FOOLS_IDS.includes(lower) || FOOLS_PATTERN.test(lower)) return 'fools';
  if (type === 'release') return 'release';
  if (type === 'snapshot') return 'snapshot';
  if (type === 'old_beta' || type === 'old_alpha') return 'old';
  return 'other';
}

/**
 * 过滤 + 搜索（纯函数，前端内存过滤也复用它）。
 * @param {Array} versions 规范化后的数组
 * @param {{category?:string, query?:string, limit?:number}} [options]
 */
function filterVersions(versions, options = {}) {
  const { category = 'release', query = '', limit = 0 } = options;
  const q = String(query || '').trim().toLowerCase();
  let list = versions.filter((v) => (category === 'all' ? true : v.category === category));
  if (q) list = list.filter((v) => v.id.toLowerCase().includes(q));
  // 清单本身就是按时间倒序的，这里再保证一次
  list = list.slice().sort((a, b) => String(b.releaseTime).localeCompare(String(a.releaseTime)));
  return limit > 0 ? list.slice(0, limit) : list;
}

/** 取某分类的最新一条（下载页顶部大卡片用） */
function pickLatest(versions, category = 'release', latestIds = {}) {
  const wanted = latestIds[category];
  if (wanted) {
    const hit = versions.find((v) => v.id === wanted);
    if (hit) return hit;
  }
  return filterVersions(versions, { category, limit: 1 })[0] || null;
}

/* ============================================================================
   网络 + 缓存（IO 层）
   ========================================================================== */

const cache = new Map();      // sourceId → { at, data }

function sourceById(id) {
  return SOURCES.find((s) => s.id === id) || SOURCES[0];
}

function sources() {
  return SOURCES.map(({ id, label }) => ({ value: id, label }));
}

function cacheInfo() {
  const out = {};
  for (const [key, value] of cache.entries()) out[key] = { at: value.at, versions: value.data.versions.length };
  return out;
}

/**
 * 拉取清单：带超时、带缓存、失败自动降级到另一个源。
 * @param {string} sourceId
 * @param {{force?:boolean, timeoutMs?:number}} [options]
 */
async function fetchManifest(sourceId = 'official', options = {}) {
  const source = sourceById(sourceId);
  const ttl = options.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
  const cached = cache.get(source.id);
  if (!options.force && cached && Date.now() - cached.at < ttl) {
    return { ...cached.data, fromCache: true, source: source.id, sourceLabel: source.label };
  }

  const order = options.force || source.id === 'official'
    ? [source, ...SOURCES.filter((s) => s.id !== source.id)]
    : [source, SOURCES.find((s) => s.id === 'official')];

  const failures = [];
  for (const item of order) {
    if (!item) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULTS.timeoutMs);
      let response;
      try {
        // redirect: 'follow' —— BMCLAPI 会 302 到签名 CDN，必须跟随
        response = await fetch(item.manifest, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': 'WMC-Launcher/1.0 (+https://example.invalid)' },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const normalized = normalizeManifest(await response.json());
      cache.set(item.id, { at: Date.now(), data: normalized });
      return {
        ...normalized,
        fromCache: false,
        source: item.id,
        sourceLabel: item.label,
        fallback: item.id !== source.id,
      };
    } catch (error) {
      failures.push(`${item.label}: ${error?.message || error}`);
    }
  }
  throw new Error(`版本清单获取失败 —— ${failures.join('；')}`);
}

/** 下载页主接口：返回某分类的版本列表 + 顶部大卡片需要的最新版 */
async function listVersions({ source = 'official', category = 'release', query = '', limit = 0, force = false } = {}) {
  const manifest = await fetchManifest(source, { force });
  const items = filterVersions(manifest.versions, { category, query, limit });
  return {
    source: manifest.source,
    sourceLabel: manifest.sourceLabel,
    fromCache: manifest.fromCache,
    fallback: !!manifest.fallback,
    latest: {
      release: pickLatest(manifest.versions, 'release', manifest.latest),
      snapshot: pickLatest(manifest.versions, 'snapshot', manifest.latest),
    },
    categories: CATEGORIES,
    total: manifest.versions.length,
    counts: CATEGORIES.reduce((acc, c) => {
      acc[c.id] = manifest.versions.filter((v) => v.category === c.id).length;
      return acc;
    }, {}),
    items,
  };
}

/** 顶部大卡片：最新正式版（也可取 snapshot） */
async function latestVersion({ source = 'official', category = 'release' } = {}) {
  const manifest = await fetchManifest(source);
  const item = pickLatest(manifest.versions, category, manifest.latest);
  return {
    source: manifest.source,
    sourceLabel: manifest.sourceLabel,
    fromCache: manifest.fromCache,
    category,
    version: item,
  };
}

/** 某个版本的详细信息（安装时要用：需要 url 指到的那个 json） */
async function versionDetail(versionId, { source = 'official' } = {}) {
  const manifest = await fetchManifest(source);
  const hit = manifest.versions.find((v) => v.id === versionId);
  if (!hit) throw new Error(`清单里没有版本 ${versionId}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);
  try {
    const response = await fetch(hit.url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const detail = await response.json();
    return {
      id: hit.id,
      type: hit.type,
      category: hit.category,
      releaseTime: hit.releaseTime,
      mainClass: detail.mainClass || '',
      assetIndex: detail.assetIndex?.id || '',
      assets: detail.assets || '',
      javaVersion: detail.javaVersion || null,
      libraries: (detail.libraries || []).length,
      client: detail.downloads?.client || null,
      detail,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SOURCES,
  CATEGORIES,
  FOOLS_IDS,
  normalizeManifest,
  classifyVersion,
  filterVersions,
  pickLatest,
  sources,
  cacheInfo,
  fetchManifest,
  listVersions,
  latestVersion,
  versionDetail,
};