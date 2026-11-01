/**
 * WMC 启动器 · 整合包识别与安装（主进程）
 * ---------------------------------------------------------------------------
 * 拖拽进来的 .zip / .mrpack 在这里被「看图识包」：
 *
 *   manifest.json            → CurseForge 整合包
 *   modrinth.index.json      → Modrinth 整合包（.mrpack）
 *   PCL/Setup.ini            → PCL2 导出的整合包
 *   mcbbs.packmeta / hmclversion.cfg / .hmcl.json → HMCL / mcbbs 格式
 *   instance.cfg / mmc-pack.json → MultiMC / Prism 实例
 *   wmc-pack.json            → WMC 自己导出的实例包
 *
 * 安装：解压到 versions/<隔离名>/（版本隔离目录），并写入 wmc-pack.json 标记，
 * 让「实例管理」页后续能直接读到这个包的身份信息。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ZipReader } = require('./wmc-zip.js');

/* ============================================================================
   签名表
   ========================================================================== */

const SIGNATURES = [
  {
    kind: 'curseforge',
    label: 'CurseForge 整合包',
    probe: ['manifest.json'],
    read: (zip) => {
      const raw = JSON.parse(zip.readText('manifest.json'));
      const loaderRaw = raw.minecraft?.modLoaders?.[0]?.id || '';
      return {
        name: raw.name || '',
        version: raw.version || '',
        author: raw.author || '',
        mcVersion: raw.minecraft?.version || '',
        loader: loaderRaw,
        loaderKind: loaderKindOf(loaderRaw),
        fileCount: Array.isArray(raw.files) ? raw.files.length : 0,
        overrides: raw.overrides || '',
        hashes: [],
        // CurseForge 只给 projectID/fileID，要装模组得再查 API；这里如实标注
        needsApi: true,
      };
    },
  },
  {
    kind: 'modrinth',
    label: 'Modrinth 整合包',
    probe: ['modrinth.index.json'],
    read: (zip) => {
      const raw = JSON.parse(zip.readText('modrinth.index.json'));
      const deps = raw.dependencies || {};
      const loaderRaw = deps['fabric-loader'] ? `fabric-loader-${deps['fabric-loader']}`
        : deps.forge ? `forge-${deps.forge}`
          : deps.neoforge ? `neoforge-${deps.neoforge}`
            : deps.quilt ? `quilt-loader-${deps.quilt}` : '';
      return {
        name: raw.name || '',
        version: raw.versionId || '',
        author: '',
        mcVersion: deps.minecraft || '',
        loader: loaderRaw,
        loaderKind: loaderKindOf(loaderRaw),
        fileCount: Array.isArray(raw.files) ? raw.files.length : 0,
        overrides: 'overrides',
        hashes: (raw.files || []).flatMap((f) => f.hashes?.sha1 ? [f.hashes.sha1] : []).slice(0, 5),
        needsApi: false,
        downloads: (raw.files || []).slice(0, 5).map((f) => ({ path: f.path, url: f.downloads?.[0] || '' })),
      };
    },
  },
  {
    kind: 'pcl2',
    label: 'PCL2 导出的整合包',
    probe: ['PCL/Setup.ini', 'pcl/setup.ini'],
    read: (zip) => {
      const text = zip.readText('PCL/Setup.ini');
      const ini = parseIni(text);
      return {
        name: ini.Name || ini.name || '',
        version: ini.Version || ini.version || '',
        author: '',
        mcVersion: ini.VersionArgument || ini.MinecraftVersion || '',
        loader: ini.Loader || '',
        loaderKind: loaderKindOf(ini.Loader || ''),
        fileCount: 0,
        overrides: '',
        hashes: [],
        needsApi: false,
        extras: { iniKeys: Object.keys(ini).slice(0, 12) },
      };
    },
  },
  {
    kind: 'hmcl',
    label: 'HMCL / mcbbs 格式整合包',
    probe: ['mcbbs.packmeta', 'hmclversion.cfg', '.hmcl.json'],
    read: (zip) => {
      const name = zip.has('mcbbs.packmeta') ? 'mcbbs.packmeta' : (zip.has('hmclversion.cfg') ? 'hmclversion.cfg' : '.hmcl.json');
      let meta = {};
      try {
        const text = zip.readText(name);
        meta = text.trim().startsWith('{') ? JSON.parse(text) : parseIni(text);
      } catch { /* 容错：解析失败不影响识别 */ }
      return {
        name: meta.name || meta.Name || '',
        version: meta.version || meta.Version || '',
        author: '',
        mcVersion: meta.gameVersion || meta.MinecraftVersion || '',
        loader: meta.loader || '',
        loaderKind: loaderKindOf(meta.loader || ''),
        fileCount: 0,
        overrides: '',
        hashes: [],
        needsApi: false,
        extras: { signature: name },
      };
    },
  },
  {
    kind: 'multimc',
    label: 'MultiMC / Prism 实例包',
    probe: ['instance.cfg', 'mmc-pack.json'],
    read: (zip) => {
      let pack = {};
      try { pack = JSON.parse(zip.readText('mmc-pack.json')); } catch { /* 容错 */ }
      const components = pack.components || [];
      const mc = components.find((c) => c.uid === 'net.minecraft');
      const loader = components.find((c) => /forge|fabric|quilt|neoforge/.test(String(c.uid)));
      const cfg = zip.has('instance.cfg') ? parseIni(zip.readText('instance.cfg')) : {};
      return {
        name: cfg.name || cfg.Name || '',
        version: '',
        author: '',
        mcVersion: mc?.version || '',
        loader: loader ? `${loader.uid}-${loader.version}` : '',
        loaderKind: loaderKindOf(String(loader?.uid || '')),
        fileCount: 0,
        overrides: '',
        hashes: [],
        needsApi: false,
      };
    },
  },
  {
    kind: 'wmc',
    label: 'WMC 实例包',
    probe: ['wmc-pack.json'],
    read: (zip) => {
      const raw = JSON.parse(zip.readText('wmc-pack.json'));
      return {
        name: raw.name || '', version: raw.version || '', author: raw.author || '',
        mcVersion: raw.mcVersion || '', loader: raw.loader || '',
        loaderKind: loaderKindOf(raw.loader || ''), fileCount: raw.fileCount || 0,
        overrides: '', hashes: [], needsApi: false,
      };
    },
  },
];

/* ============================================================================
   纯函数：识别 / 解析辅助
   ========================================================================== */

/** 从加载器标识推断种类（供「实例管理」显示标签） */
function loaderKindOf(loader) {
  const s = String(loader || '').toLowerCase();
  if (s.includes('neoforge')) return 'neoforge';
  if (s.includes('forge')) return 'forge';
  if (s.includes('fabric')) return 'fabric';
  if (s.includes('quilt')) return 'quilt';
  if (s.includes('optifine')) return 'optifine';
  return '';
}

/** 极简 ini 解析（PCL2 / MultiMC 的 cfg 都很简单，够用） */
function parseIni(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** 遍历签名表判断包类型（不读盘，便于单测） */
function detectSignature(zip) {
  for (const sig of SIGNATURES) {
    const hit = sig.probe.find((name) => zip.has(name));
    if (hit) {
      let meta = {};
      try {
        meta = sig.read(zip);
      } catch (error) {
        return {
          kind: sig.kind, label: sig.label, evidence: hit,
          meta: {}, error: `解析 ${hit} 失败：${error?.message || error}`,
        };
      }
      return { kind: sig.kind, label: sig.label, evidence: hit, meta };
    }
  }
  return { kind: 'unknown', label: '无法识别的压缩包', evidence: '', meta: {} };
}

/** 隔离目录名：去掉 Windows / macOS 不允许的字符 */
function safeFolderName(name, fallback = 'imported-pack') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const short = cleaned.slice(0, 48).trim();
  return short || fallback;
}

/** 生成不重名的隔离名：名字已存在时追加 -2 / -3 … */
function uniqueFolderName(versionsDir, base) {
  let candidate = base;
  let i = 2;
  while (fs.existsSync(path.join(versionsDir, candidate))) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  return candidate;
}

/* ============================================================================
   IO：检查 / 安装
   ========================================================================== */

/**
 * 检查一个拖进来的文件：识别类型 + 解析元信息（不改动磁盘）。
 * @param {string} filePath
 */
function inspectPack(filePath) {
  const stat = fs.statSync(filePath);
  const zip = ZipReader.open(filePath);
  const detected = detectSignature(zip);
  const entries = zip.names();

  return {
    ok: detected.kind !== 'unknown',
    file: {
      path: filePath,
      name: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      sizeBytes: stat.size,
      entryCount: entries.length,
      zip64: !!zip.zip64,
    },
    kind: detected.kind,
    label: detected.label,
    evidence: detected.evidence,
    meta: detected.meta,
    error: detected.error || '',
    hasOverrides: entries.some((n) => /^overrides\//i.test(n)),
    hasMods: entries.some((n) => /^overrides\/mods\/.+\.jar$/i.test(n) || /^mods\/.+\.jar$/i.test(n)),
    topLevel: [...new Set(entries.map((n) => n.split(/[\\/]/)[0]))].slice(0, 12),
  };
}

/**
 * 安装整合包：解压到版本隔离目录，并写 wmc-pack.json 标记。
 * @param {{filePath:string, versionsDir:string, name?:string, overwrite?:boolean, dryRun?:boolean}} options
 */
function installPack(options = {}) {
  const {
    filePath, versionsDir, name, overwrite = false, dryRun = false,
  } = options;
  if (!filePath) throw new Error('缺少 filePath');
  if (!versionsDir) throw new Error('缺少 versionsDir（游戏目录下的 versions 文件夹）');

  const report = inspectPack(filePath);
  if (!report.ok) {
    const error = new Error(report.error || `无法识别的压缩包：${report.file.name}`);
    error.code = 'UNKNOWN_PACK';
    throw error;
  }

  const base = safeFolderName(name || report.meta?.name || path.basename(filePath, path.extname(filePath)));
  fs.mkdirSync(versionsDir, { recursive: true });
  const folder = overwrite ? base : uniqueFolderName(versionsDir, base);
  const targetDir = path.join(versionsDir, folder);

  if (dryRun) {
    return { ...report, isolation: folder, targetDir, dryRun: true, extracted: 0, skipped: [] };
  }

  const zip = ZipReader.open(filePath);
  const { extracted, skipped } = zip.extractTo(targetDir, { overwrite: true });

  const marker = {
    name: report.meta?.name || folder,
    version: report.meta?.version || '',
    mcVersion: report.meta?.mcVersion || '',
    loader: report.meta?.loader || '',
    loaderKind: report.meta?.loaderKind || '',
    packKind: report.kind,
    packLabel: report.label,
    sourceFile: report.file.name,
    importedAt: new Date().toISOString(),
    fileCount: report.meta?.fileCount || 0,
  };
  fs.writeFileSync(path.join(targetDir, 'wmc-pack.json'), JSON.stringify(marker, null, 2), 'utf8');

  return {
    ...report,
    isolation: folder,
    targetDir,
    marker,
    extracted,
    skipped,
    dryRun: false,
  };
}

module.exports = {
  SIGNATURES,
  loaderKindOf,
  parseIni,
  detectSignature,
  safeFolderName,
  uniqueFolderName,
  inspectPack,
  installPack,
};