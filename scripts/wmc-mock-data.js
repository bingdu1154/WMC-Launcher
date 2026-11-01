/**
 * WMC 面板 · 离线预览用模拟数据
 * ---------------------------------------------------------------------------
 * 目的：让「下载中心」在没有后端/没有网络时也能完整演示分页、骨架屏、进度、筛选。
 * 特性：
 *   - 确定性伪随机（同一个 seed 永远生成同一批数据）→ 翻页不会「换内容」；
 *   - 封面用内联 SVG data-URI 生成，不依赖任何图片资源与网络；
 *   - 覆盖中英文混合的模组/整合包/资源包/光影/地图/插件/数据包/原版。
 */
import { hashString } from './wmc-dom.js';

/** mulberry32：小巧的确定性伪随机 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];

/* ------------------------------------------------------------------ 封面生成 */

/* 封面配色：水墨青绿体系（黛蓝 / 青玉 / 竹青 / 远山灰），刻意不出现红金 */
const COVER_PALETTES = [
  ['#2B3A42', '#5E7C86'],
  ['#3A6E62', '#8FB6A6'],
  ['#31555E', '#7FA6AE'],
  ['#44586A', '#93AFC0'],
  ['#2F4A44', '#84A79A'],
  ['#3E4E59', '#8CA3AE'],
  ['#405A55', '#9BBFB2'],
  ['#35424E', '#8898A6'],
];

const CATEGORY_LABEL = {
  vanilla: '原版', mod: '模组', modpack: '整合包', datapack: '数据包',
  resourcepack: '资源包', shader: '光影包', map: '地图', plugin: '服务器插件',
};

/**
 * 生成一张「国风抽象封面」（SVG → data URI）。
 * 真机上你的后端会返回真实封面 URL，这个函数只用于预览与兜底。
 */
export function makeCover(title, category, seed = 0) {
  const [c1, c2] = COVER_PALETTES[hashString(title + seed) % COVER_PALETTES.length];
  const label = CATEGORY_LABEL[category] || '资源';
  const rand = rng(hashString(title + category));
  // 三条随机的「山脊线」，让封面不那么单调
  const ridges = [0, 1, 2].map((i) => {
    const y = 74 + i * 16 + rand() * 8;
    const amp = 8 + rand() * 14;
    return `<path d="M0 ${y} Q 60 ${y - amp} 120 ${y} T 240 ${y}" fill="none" stroke="rgba(255,255,255,${0.08 + i * 0.04})" stroke-width="1.5"/>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(255,255,255,0.22)"/>
      <stop offset="1" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>
  <rect width="480" height="270" fill="url(#g)"/>
  <g opacity="0.9">${ridges}</g>
  <rect width="480" height="150" fill="url(#sheen)"/>
  <path d="M180 0 L268 270" stroke="rgba(255,255,255,0.10)" stroke-width="44" fill="none"/>
  <rect x="20" y="20" width="30" height="30" rx="5" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.44)"/>
  <text x="35" y="41" text-anchor="middle" font-family="SimSun, serif"
        font-size="16" fill="#F4F9F8">${escapeXml(label.slice(0, 1))}</text>
  <text x="460" y="252" text-anchor="end" font-family="SimSun, Songti SC, serif"
        font-size="15" fill="rgba(255,255,255,0.55)">${escapeXml(label)}</text>
</svg>`;

  // 换行 + 缩进折成单个空格：直接删掉会把跨行的属性粘在一起（XHTML 非法），
  // 曾经导致所有封面解码失败并回退到兜底图。
  return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s*\n\s*/g, ' ').trim());
}

function escapeXml(str) {
  return String(str ?? '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

/* ------------------------------------------------------------------ 名称池 */

const MOD_NAMES = [
  '通用机械扩展', '匠魂工艺', '沉浸工程', '暮色森林', '虚无世界', '工业时代经典',
  '植物魔法', '神秘时代', '热力膨胀', '等价交换', '星空物语', '梦回三国',
  'Rats 鼠患', 'Alex 的生物', '农夫乐事', '机械动力', '矿石挖掘', '背包整理',
  '光影兼容补丁', '区块预加载', 'FPS 优化器', '内存泄漏修复', '中文输入修复', '模组菜单',
];
const MODPACK_NAMES = [
  '盛世长安', '山海经', '剑与魔法', '机械帝国', '末日废土', '神话纪元',
  'Better MC', 'All the Mods 10', 'RLCraft 重制', '惊变 100 天', '工业革命', '像素牧场',
];
const RESOURCE_NAMES = [
  '水墨风格材质', '宋韵界面', '古典 GUI', '像素写实', '青花瓷材质', '竹林风材质',
  '中式建筑包', '简笔风格', '柔光音效', '原版增强',
];
const SHADER_NAMES = [
  '光影 · 云海', '光影 · 落霞', '光影 · 江南烟雨', 'BSL 增强', 'Complementary 重制',
  'Chocapic 国风版', 'Soft Waves', '光影 · 竹影',
];
const MAP_NAMES = [
  '长安城复刻', '江南水乡', '故宫 1:1', '蜀道难', '海上丝绸之路', '悬空寺',
  '跑酷 · 天阶', '生存 · 荒岛', '迷宫 · 九宫', 'RPG · 江湖',
];
const PLUGIN_NAMES = [
  '领地保护', '经济系统', '抽奖箱', '菜单界面', '反作弊增强', '多世界管理',
  '公会系统', '任务系统', 'NPC 对话', '自动备份',
];
const DATAPACK_NAMES = [
  '一键砍树', '更多合成', '难度调整', '生物增强', '地形生成', '成就扩展',
];
const VANILLA_NAMES = ['1.21.1', '1.21', '1.20.6', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.7.10'];

const AUTHORS = [
  '墨白', '青竹', '子墨', '長風', '拾光', '南栀', '清和', 'Aria', 'Nova', 'Kirin',
  'Sodion', 'Yuki', 'Hana', 'Mio', 'AzureDev', 'ColdWind',
];
const TAG_POOL = ['forge', 'fabric', 'neoforge', '1.20.1', '1.21', '中文', '轻量', '优化', '建筑', '生存'];
const SOURCES = [
  { id: 'curseforge', label: 'CurseForge', cls: 'curseforge' },
  { id: 'modrinth', label: 'Modrinth', cls: 'modrinth' },
  { id: 'official', label: '官方', cls: 'official' },
];

const DESC_POOL = [
  '在保留原版平衡的前提下扩充玩法，附带完整的中文任务指引与配方手册。',
  '专注性能与兼容性：重构渲染路径、修复常见内存泄漏，低配机器也能稳定 60 帧。',
  '新增 200+ 装饰方块与建筑构件，适合中式庭院、园林与城池建造。',
  '提供完整的天气、光影与音效联动，让昼夜与季节变化更具沉浸感。',
  '与主流整合包兼容，安装后无需额外配置，开箱即用。',
  '内置材质自动适配，支持高清与低配两档资源，可随时切换。',
  '重做了界面与交互，按键一览与说明文档均可在游戏内直接查看。',
  '由社区共同维护，持续跟进最新版本，更新日志透明公开。',
];

/* ------------------------------------------------------------------ 数据生成 */

export const CATEGORIES = [
  { id: 'vanilla', name: '原版', icon: '🪶', note: '官方版本与安装包' },
  { id: 'mod', name: '模组', icon: '🧩', note: 'Forge / Fabric / NeoForge' },
  { id: 'modpack', name: '整合包', icon: '📦', note: '一键安装的完整整合' },
  { id: 'datapack', name: '数据包', icon: '📜', note: '配方 / 进度 / 地形' },
  { id: 'resourcepack', name: '资源包', icon: '🎨', note: '材质 / 界面 / 音效' },
  { id: 'shader', name: '光影包', icon: '🌅', note: '需要 OptiFine / Iris' },
  { id: 'map', name: '地图', icon: '🗺', note: '存档与世界' },
  { id: 'plugin', name: '服务器插件', icon: '⚙', note: 'Bukkit / Paper / Spigot' },
];

const NAME_POOL = {
  vanilla: () => pick(rng(0), VANILLA_NAMES),
  mod: MOD_NAMES, modpack: MODPACK_NAMES, datapack: DATAPACK_NAMES,
  resourcepack: RESOURCE_NAMES, shader: SHADER_NAMES,
  map: MAP_NAMES, plugin: PLUGIN_NAMES,
};

/** 每个分类生成的条目数（够演示分页与触底加载） */
const COUNT_PER_CATEGORY = {
  vanilla: 9, mod: 48, modpack: 22, datapack: 18,
  resourcepack: 20, shader: 14, map: 16, plugin: 18,
};

function buildDataset() {
  const items = [];
  for (const category of CATEGORIES) {
    const count = COUNT_PER_CATEGORY[category.id] || 12;
    const rand = rng(hashString('wmc-' + category.id));
    const pool = NAME_POOL[category.id];
    for (let i = 0; i < count; i += 1) {
      const baseName = category.id === 'vanilla'
        ? VANILLA_NAMES[i % VANILLA_NAMES.length]
        : pool[(i * 7 + 3) % pool.length];
      // 同名条目加序号后缀，避免整合包/资源包里出现重复标题
      const title = category.id === 'vanilla' ? `Minecraft ${baseName}`
        : (i < pool.length ? baseName : `${baseName} · ${Math.floor(i / pool.length) + 1}`);
      const source = pick(rand, SOURCES);
      const downloads = Math.floor(rand() * 4_800_000) + 800;
      const tags = [pick(rand, TAG_POOL), pick(rand, TAG_POOL)].filter((t, idx, arr) => arr.indexOf(t) === idx);
      items.push({
        id: `${category.id}-${i + 1}`,
        category: category.id,
        title,
        author: pick(rand, AUTHORS),
        desc: pick(rand, DESC_POOL),
        sourceId: source.id,
        sourceLabel: source.label,
        sourceClass: source.cls,
        downloads,
        tags,
        updatedAt: Date.now() - Math.floor(rand() * 90) * 86400000,
        cover: makeCover(title, category.id, i),
        installed: rand() < 0.12,
        sizeBytes: Math.floor(rand() * 900_000_000) + 200_000,
      });
    }
  }
  return items;
}

/** 内存中唯一的数据集（确定性） */
const DATASET = buildDataset();

const SORT_OPTIONS = [
  { value: 'popular', label: '按热度' },
  { value: 'recent', label: '按更新时间' },
  { value: 'name', label: '按名称' },
  { value: 'size', label: '按大小' },
];

/**
 * 模拟「目录接口」：与真实后端的 search 语义保持一致。
 * @param {{category?:string, source?:string, query?:string, sort?:string, page?:number, pageSize?:number}} params
 */
export function mockSearch(params = {}) {
  const {
    category = 'mod', source = 'all', query = '', sort = 'popular',
    page = 1, pageSize = 24,
  } = params;

  let list = DATASET.filter((it) => it.category === category);
  if (source && source !== 'all') list = list.filter((it) => it.sourceId === source);
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    list = list.filter((it) => it.title.toLowerCase().includes(q)
      || it.author.toLowerCase().includes(q)
      || (it.tags || []).some((t) => t.toLowerCase().includes(q)));
  }

  const comparators = {
    popular: (a, b) => b.downloads - a.downloads,
    recent: (a, b) => b.updatedAt - a.updatedAt,
    name: (a, b) => a.title.localeCompare(b.title, 'zh-CN'),
    size: (a, b) => b.sizeBytes - a.sizeBytes,
  };
  list = list.slice().sort(comparators[sort] || comparators.popular);

  const total = list.length;
  const start = Math.max(0, (page - 1) * pageSize);
  const items = list.slice(start, start + pageSize);
  return { items, total, page, pageSize, hasMore: start + items.length < total };
}

/** 分类列表（带数量，用于侧栏角标） */
export function mockCategories() {
  return CATEGORIES.map((c) => ({
    ...c,
    count: DATASET.filter((it) => it.category === c.id).length,
  }));
}

/** 排序选项 */
export function mockSorts() {
  return SORT_OPTIONS.slice();
}

/** 下载源 */
export function mockSources() {
  return [
    { value: 'auto', label: '智能选择', desc: '自动测速' },
    { value: 'bmclapi', label: 'BMCLAPI 镜像', desc: '国内推荐' },
    { value: 'official', label: '官方源', desc: 'Mojang' },
    { value: 'curseforge', label: 'CurseForge 源', desc: '模组直连' },
  ];
}

/** Java 运行时 */
export function mockJavaList(refresh = false) {
  const base = [
    { id: 'j21', name: 'Java 21', version: '21.0.8+12-LTS', vendor: 'Adoptium', path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.8\\bin\\java.exe', arch: 'x64', ok: true },
    { id: 'j17', name: 'Java 17', version: '17.0.12+7', vendor: 'Microsoft', path: 'C:\\Program Files\\Microsoft\\jdk-17.0.12\\bin\\java.exe', arch: 'x64', ok: true },
  ];
  if (refresh) base.push({ id: 'j8', name: 'Java 8', version: '1.8.0_402', vendor: 'Oracle', path: 'C:\\Program Files\\Java\\jre1.8.0_402\\bin\\java.exe', arch: 'x64', ok: false, reason: '版本过低，仅适用于 1.16 及更早版本' });
  return base;
}

/** 系统信息 */
export function mockSystemInfo() {
  return {
    os: 'Windows 10 (amd64)',
    arch: 'x64',
    cpuCount: 24,
    totalMemMb: 16384,
    freeMemMb: 9120,
    launcherVersion: '1.0.0',
    gameDir: 'C:\\Users\\Public\\Documents\\WMC\\.minecraft',
    gameDirWritable: true,
  };
}

/** 默认配置 */
export function mockConfig() {
  return {
    javaPath: '',
    maxMemoryMb: 4096,
    minMemoryMb: 1024,
    downloadSource: 'auto',
    downloadThreads: 8,
    gameDir: '',
    verifyDownloads: true,
    // 下面几项任务 2/4 会用到，先按合理默认值给出
    lastVersionId: '',
    versionIsolation: true,
    hideLauncherOnLaunch: false,
    theme: 'paper',
  };
}

/** 下载源测速（模拟延迟） */
export function mockSourceLatency() {
  return [
    { value: 'auto', label: '智能选择', latencyMs: 0 },
    { value: 'bmclapi', label: 'BMCLAPI 镜像', latencyMs: 486 },
    { value: 'official', label: '官方源', latencyMs: 1180 },
    { value: 'curseforge', label: 'CurseForge 源', latencyMs: 742 },
  ];
}

/** 当前账号（导航左下角用户组件用；任务 5 会接真实账号体系） */
export function mockAccount() {
  return {
    id: 'local-chuangxiang',
    name: '冒险者',
    type: 'offline',            // offline | microsoft | littleskin
    typeLabel: '离线登录',
    online: false,
    uuid: 'c0a1b2c3d4e5f60718293a4b5c6d7e8f',
    avatarGlyph: 'W',
    skinModel: 'classic',
    skinUrl: null,
    capeUrl: null,
  };
}

/** 首页推荐流（与下载中心同构的 item，便于复用卡片组件） */
export function mockRecommended(count = 4) {
  const items = mockSearch({ category: 'mod', sort: 'popular', page: 1, pageSize: count }).items;
  return items.slice(0, count);
}

/** 首页六宫格入口（含两个特色功能：环境体检 / 存档速览） */
export function mockQuickEntries() {
  return [
    {
      id: 'health',
      icon: 'pulse',
      name: '环境体检',
      desc: '一键检测 Java、内存与缺失依赖',
      action: 'health',
      tag: '特色',
    },
    {
      id: 'worlds',
      icon: 'map',
      name: '存档速览',
      desc: '一键查看最近玩过的 3 个世界',
      action: 'worlds',
      tag: '特色',
    },
    { id: 'mod', icon: 'cube', name: '模组', desc: 'Forge / Fabric / NeoForge', action: 'route' },
    { id: 'resourcepack', icon: 'palette', name: '材质', desc: '材质包与界面贴图', action: 'route' },
    { id: 'shader', icon: 'shader', name: '光影', desc: '需要 Iris / OptiFine', action: 'route' },
    { id: 'modpack', icon: 'pack', name: '整合包', desc: '一步装好整套环境', action: 'route' },
  ];
}

/** 存档速览：最近玩过的世界（真机上换成读 saves 目录 + level.dat） */
export function mockRecentWorlds() {
  return [
    {
      name: '长安城',
      version: '原版',
      lastPlayed: '今天 14:20',
      playtime: '42 小时',
      sizeBytes: 268_435_456,
      seed: '8842190231',
    },
    {
      name: '竹林小屋',
      version: 'Forge',
      lastPlayed: '昨天 22:05',
      playtime: '17 小时',
      sizeBytes: 96_468_992,
      seed: '-3319004465',
    },
    {
      name: '云端试炼场',
      version: 'Fabric',
      lastPlayed: '3 天前',
      playtime: '6 小时',
      sizeBytes: 41_943_040,
      seed: '1204871',
    },
  ];
}

/**
 * 今日开荒运势：用日期做确定性随机，同一天刷新结果不变（不会「刷一次变一次」）。
 */
export function mockFortune(date = new Date()) {
  const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const rand = rng(hashString('fortune-' + key));
  const levels = ['大吉', '吉', '中平', '小凶', '宜静观'];
  const goodPool = ['挖矿建房子', '探索下界', '整理仓库', '养蜂种田', '附魔炼药', '钓鱼摸鱼', '联机开黑'];
  const badPool = ['打末影龙', '夜闯洞穴', '硬刚凋灵', '乱装模组', '在岩浆边挖矿'];
  const goodIdx = [0, 1].map(() => Math.floor(rand() * goodPool.length));
  const badIdx = [0].map(() => Math.floor(rand() * badPool.length));
  const level = levels[Math.floor(rand() * levels.length)];
  // 「宜 / 忌」固定带上最经典的两条（挖矿建房子 / 打末影龙），再补一条当日随机
  const good = [...new Set(['挖矿建房子', ...goodIdx.map((i) => goodPool[i])])].slice(0, 2);
  const bad = [...new Set(['打末影龙', ...badIdx.map((i) => badPool[i])])].slice(0, 2);
  return {
    date: `${date.getMonth() + 1} 月 ${date.getDate()} 日`,
    level,
    luck: 40 + Math.floor(rand() * 60),
    good,
    bad,
    note: level === '大吉' || level === '吉'
      ? '宜开局新档：先定基地再铺矿道，今晚灵感在线。'
      : '稳一点：备份存档、少动配置，先把版本与依赖理顺。',
    isGood: level === '大吉' || level === '吉',
  };
}

/** 覆盖图（供外部按 id 取） */
export function mockCoverOf(item) {
  return item?.cover || makeCover(item?.title || 'M', item?.category || 'mod', 0);
}