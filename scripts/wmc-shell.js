/**
 * WMC · 全局外壳
 * ---------------------------------------------------------------------------
 * 职责：
 *   · 左侧导航（分组 / 选中态金边 / MOD·PACK 角标 / 左下角用户组件）
 *   · 顶部栏（两行页目标题 + 搜索 + 设置齿轮 + 窗口按钮）
 *   · 页面路由（注册 + 懒挂载 + 卸载清理），未实现的页面自动落到占位卡
 *
 * 用法：
 *   const shell = createShell(document.querySelector('[data-wmc-app]'), { bridge });
 *   shell.addPage('home', (host) => mountHome(host, { bridge, shell }));
 *   await shell.navigate('home');
 */
import { el, iconSvg, on, qs, qsa } from './wmc-dom.js';
import { toastInfo, toastErr } from './wmc-toast.js';

/* ============================================================================
   导航结构（任务 1 定稿；任务 2~5 只往里加 id 对应的页面实现）
   ========================================================================== */

export const NAV_GROUPS = [
  {
    title: '开始',
    items: [
      { id: 'home', en: 'DASHBOARD', cn: '首页', icon: 'home' },
      { id: 'game', en: 'GAME', cn: '游戏下载', icon: 'download' },
    ],
  },
  {
    title: '游戏管理',
    items: [
      // 实例管理：管理已安装的版本与版本隔离
      { id: 'instances', en: 'INSTANCES', cn: '实例管理', icon: 'layers' },
      { id: 'saves', en: 'SAVES', cn: '存档管理', icon: 'folder', badge: 'SAVES' },
    ],
  },
  {
    title: '资源中心',
    items: [
      { id: 'mod', en: 'MODS', cn: '模组下载', icon: 'cube', badge: 'MOD' },
      { id: 'modpack', en: 'MODPACKS', cn: '整合包下载', icon: 'pack', badge: 'PACK' },
      { id: 'resourcepack', en: 'TEXTURES', cn: '资源包下载', icon: 'palette', badge: 'RP' },
      { id: 'shader', en: 'SHADERS', cn: '光影下载', icon: 'shader', badge: 'SHADER' },
      { id: 'map', en: 'MAPS', cn: '地图下载', icon: 'map', badge: 'MAP' },
      { id: 'datapack', en: 'DATAPACKS', cn: '数据包下载', icon: 'book', badge: 'DATA' },
      { id: 'plugin', en: 'PLUGINS', cn: '服务器插件', icon: 'plug', badge: 'PLUGIN' },
    ],
  },
  {
    title: '系统',
    items: [
      { id: 'account', en: 'ACCOUNT', cn: '账户中心', icon: 'user' },
      // Java 与运行环境：Java 检测 / 内存分配 / 下载源 / 游戏目录
      { id: 'runtime', en: 'RUNTIME', cn: 'Java 与运行环境', icon: 'cpu' },
      { id: 'settings', en: 'SETTINGS', cn: '启动器设置', icon: 'gear' },
    ],
  },
];

/** id → 页面元信息（标题两行 / 图标 / 分组） */
export const PAGE_META = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, { ...item, group: group.title }])),
);

/** 未实现页面的说明（点击菜单后主区域显示的两行标题 + 说明卡） */
const PENDING = {
  game: { task: '任务 2', icon: '🪶', text: '游戏下载：接入 Mojang 版本清单（走 BMCLAPI 镜像），提供版本号 / 正式版·快照标签 / 发布时间 / 朱砂红「安装」按钮的极简列表。数据为真实接口，不使用假数据。' },
  instances: { task: '任务 2', icon: '🗂', text: '实例管理：列出已安装的版本与加载器（Forge / Fabric / NeoForge），支持版本隔离目录、复制 / 删除 / 重命名实例，以及为每个实例单独配置内存与 Java。' },
  saves: { task: '任务 2', icon: '📁', text: '存档管理：读取 .minecraft/saves，展示世界名称 / 版本 / 最后游玩时间 / 体积，支持备份为 zip、导入与打开目录。' },
  mod: { task: '任务 3', icon: '🧩', text: '模组下载：顶部筛选栏（CurseForge / Modrinth 数据源切换 + 圆角搜索框 + 全部版本 / 全部加载器 / 综合排序三个自定义下拉），下方 3~4 列卡片流，点击「获取」显示真实下载进度。' },
  modpack: { task: '任务 3', icon: '📦', text: '整合包下载：与模组下载共用卡片流与筛选栏，额外提供「一键安装到新版本」入口。' },
  resourcepack: { task: '任务 3', icon: '🎨', text: '资源包下载：按分辨率 / 风格筛选，支持预览图与「获取」。' },
  shader: { task: '任务 3', icon: '🌅', text: '光影下载：列出支持 Iris / OptiFine 的光影包，标注需要的加载器与性能开销。' },
  map: { task: '任务 3', icon: '🗺', text: '地图下载：按玩法 / 规模筛选冒险与建筑地图，支持下载后直接放入 saves。' },
  datapack: { task: '任务 3', icon: '📜', text: '数据包下载：按版本筛选配方 / 进度 / 地形类数据包，可指定放入某个世界。' },
  plugin: { task: '任务 3', icon: '🔌', text: '服务器插件：面向 Paper / Spigot / Fabric 服务端的插件检索与下载，标注兼容的服务端与版本。' },
  account: { task: '任务 5', icon: '👤', text: '账户中心：管理微软正版与离线账号，切换当前账号、查看皮肤与披风预览、修改昵称。' },
  runtime: { task: '任务 4', icon: '⚙', text: 'Java 与运行环境：Java 检测与手动指定、内存分配、下载源选择、游戏目录设置，状态用青玉 / 朱砂两色提示。' },
  settings: { task: '任务 4', icon: '⚙', text: '启动器设置：下载设置（国风下拉 + 线程数）/ 游戏行为（版本隔离、启动后隐藏启动器）/ 启动器外观（宣纸白·水墨黑 + 自定义背景图），所有修改实时写入 config.json。' },
};

/* ============================================================================
   外壳
   ========================================================================== */

export function createShell(root, options = {}) {
  if (!root) throw new Error('createShell: 缺少根节点');
  const bridge = options.bridge || null;

  const hooks = {
    menu: qs(root, '[data-wmc-nav-menu]'),
    titleEn: qs(root, '[data-wmc-title-en]'),
    titleCn: qs(root, '[data-wmc-title-cn]'),
    pageHost: qs(root, '[data-wmc-page-host]'),
    search: qs(root, '[data-wmc-search]'),
    gear: qs(root, '[data-wmc-gear]'),
    user: qs(root, '[data-wmc-user]'),
    userName: qs(root, '[data-wmc-user-name]'),
    userState: qs(root, '[data-wmc-user-state]'),
    userVersion: qs(root, '[data-wmc-user-version]'),
    userAvatar: qs(root, '[data-wmc-user-avatar]'),
  };
  if (!hooks.menu) throw new Error('createShell: 缺少 [data-wmc-nav-menu]');
  if (!hooks.pageHost) throw new Error('createShell: 缺少 [data-wmc-page-host]');

  const pages = new Map();
  const cleanups = [];
  const navButtons = new Map();
  let currentId = null;
  let currentHandle = null;
  let windowHintShown = false;

  /* ---------------------------------------------------------------- 导航渲染 */
  function renderNav() {
    const frag = document.createDocumentFragment();
    for (const group of NAV_GROUPS) {
      frag.append(el('div', { class: 'wmc-nav__group', text: group.title }));
      for (const item of group.items) {
        const icon = el('span', { class: 'wmc-nav__icon' });
        icon.innerHTML = iconSvg(item.icon, 17);
        const button = el('button', {
          class: 'wmc-nav__item',
          attrs: { type: 'button', 'aria-label': item.cn },
          dataset: { nav: item.id },
        }, [
          icon,
          el('span', { class: 'wmc-nav__label', text: item.cn }),
          item.badge ? el('span', { class: 'wmc-nav__badge', text: item.badge }) : null,
        ]);
        navButtons.set(item.id, button);
        frag.append(button);
      }
    }
    hooks.menu.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------- 路由 */
  function addPage(id, mount) {
    pages.set(id, mount);
  }

  /** 生成「任务未开始」的说明卡 */
  function placeholder(info) {
    return el('div', { class: 'wmc-placeholder' }, [
      el('div', { class: 'wmc-placeholder__icon', text: info.icon || '🪶' }),
      el('div', { class: 'wmc-placeholder__title', text: `${info.task} 待开发` }),
      el('div', { class: 'wmc-placeholder__text', text: info.text || '' }),
    ]);
  }

  async function navigate(id) {
    const meta = PAGE_META[id];
    if (!meta) return null;

    // 卸载上一个页面
    if (typeof currentHandle === 'function') {
      try { currentHandle(); } catch { /* 卸载失败不影响切换 */ }
    }
    currentHandle = null;

    currentId = id;
    navButtons.forEach((button, key) => {
      const active = key === id;
      button.classList.toggle('wmc-nav__item--active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    if (hooks.titleEn) hooks.titleEn.textContent = meta.en;
    if (hooks.titleCn) hooks.titleCn.textContent = meta.cn;

    hooks.pageHost.replaceChildren();
    if (pages.has(id)) {
      const result = pages.get(id)(hooks.pageHost, api);
      currentHandle = typeof result === 'function' ? result : (result?.destroy ?? null);
    } else {
      hooks.pageHost.append(placeholder(PENDING[id] || { task: '后续任务', text: '该页面尚未实现。' }));
    }
    return currentId;
  }

  /* ---------------------------------------------------------------- 交互 */
  cleanups.push(on(hooks.menu, 'click', (event) => {
    const button = event.target.closest?.('[data-nav]');
    if (button?.dataset.nav) navigate(button.dataset.nav);
  }));

  // 顶部栏：搜索（回车触发）/ 设置齿轮
  cleanups.push(on(hooks.search, 'keydown', (event) => {
    if (event.key !== 'Enter') return;
    const value = hooks.search.value.trim();
    if (!value) return;
    if (typeof options.onSearch === 'function') options.onSearch(value);
    else toastInfo('全局搜索', `「${value}」：全局搜索将在任务 3 接入（届时可直接跳到模组下载页并带上关键词）`);
  }));

  cleanups.push(on(hooks.gear, 'click', () => navigate('settings')));

  // 窗口按钮：接 Electron 主进程；纯浏览器预览时只提示一次
  const windowActions = { minimize: 'minimize', maximize: 'maximize', close: 'close' };
  for (const button of qsa(root, '[data-wmc-win]')) {
    cleanups.push(on(button, 'click', async () => {
      const action = windowActions[button.dataset.wmcWin];
      if (!action) return;
      const controls = bridge?.windowControls;
      if (bridge?.mode === 'ipc' && controls) {
        try { await controls[action](); return; } catch (error) { toastErr('窗口操作失败', String(error?.message || error)); return; }
      }
      if (!windowHintShown) {
        windowHintShown = true;
        toastInfo('窗口按钮已就绪', '已接好 bridge.windowControls；在浏览器预览里不会真的最小化/关闭，装进 Electron 后即生效。');
      }
    }));
  }

  // 左下角用户组件：任务 5 会换成账户中心弹窗
  cleanups.push(on(hooks.user, 'click', () => {
    if (typeof options.onUserClick === 'function') options.onUserClick();
    else toastInfo('账户与皮肤', '账户中心将在任务 5 实现（离线登录 / 微软正版 / LittleSkin + 皮肤披风预览）');
  }));

  /* ---------------------------------------------------------------- 用户信息 */
  function updateUser(account, version) {
    const name = account?.name || '冒险者';
    if (hooks.userName) hooks.userName.textContent = name;
    if (hooks.userState) {
      const online = account?.online === true;
      const label = account?.typeLabel || (online ? '正版登录' : '离线登录');
      hooks.userState.replaceChildren(
        el('span', { class: `wmc-nav__dot${online ? '' : ' wmc-nav__dot--offline'}` }),
        el('span', { text: label }),
      );
    }
    if (hooks.userAvatar) {
      hooks.userAvatar.textContent = account?.avatarGlyph || name.charAt(0) || 'W';
      if (account?.skinUrl) hooks.userAvatar.style.backgroundImage = `url("${account.skinUrl}")`;
    }
    if (hooks.userVersion) {
      hooks.userVersion.textContent = `WMC · v${version || '1.0.0'}`;
    }
  }

  async function loadAccount() {
    if (!bridge) return null;
    try {
      const [account, system] = await Promise.all([bridge.account(), bridge.systemInfo()]);
      updateUser(account, system?.launcherVersion);
      return account;
    } catch (error) {
      toastErr('读取账号失败', String(error?.message || error));
      return null;
    }
  }

  const api = {
    navigate,
    addPage,
    getId: () => currentId,
    getPageMeta: (id) => PAGE_META[id],
    placeholder,
    updateUser,
    loadAccount,
    /** 供页面调用：把标题临时改成别的两行文案（例如子标签页） */
    setTitle(en, cn) {
      if (hooks.titleEn) hooks.titleEn.textContent = en;
      if (hooks.titleCn) hooks.titleCn.textContent = cn;
    },
    destroy() {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      if (typeof currentHandle === 'function') currentHandle();
      hooks.pageHost.replaceChildren();
      hooks.menu.replaceChildren();
      navButtons.clear();
      pages.clear();
    },
  };

  renderNav();
  loadAccount();
  return api;
}