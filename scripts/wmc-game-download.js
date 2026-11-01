/**
 * WMC 启动器 · 游戏下载页（原版版本下载）
 * ---------------------------------------------------------------------------
 * 数据来源：全部来自主进程（wmc:versions:*），本文件**不做任何网络请求**，
 *           也没有内置假版本列表；拿不到 IPC 时直接显示红字错误。
 *
 * 功能：
 *   · 顶部大卡片：最新正式版（真实 latest）+ 一键安装最新版
 *   · 筛选栏：分类下拉（正式版/预览版/远古版/愚人节版）、下载源（官方/BMCLAPI）、
 *             版本号搜索（前端内存过滤）、刷新（强制重新拉取）
 *   · 极简列表行：大字版本号 / 类型标签 / 发布时间 / 朱砂红安装按钮
 *   · 加载态骨架屏、失败红字、空结果提示
 */
import { createSelect } from './wmc-custom-select.js';
import { kvRow, openWmcDialog } from './wmc-dragdrop.js';
import { debounce, el, iconSvg, on, qs } from './wmc-dom.js';
import { toastErr, toastInfo, toastOk } from './wmc-toast.js';

const CATEGORIES = [
  { value: 'release', label: '正式版' },
  { value: 'snapshot', label: '预览版' },
  { value: 'old', label: '远古版' },
  { value: 'fools', label: '愚人节版' },
];

const SOURCES = [
  { value: 'official', label: 'Mojang 官方源' },
  { value: 'bmclapi', label: 'BMCLAPI 镜像' },
];

const TAG_LABEL = { release: '正式版', snapshot: '预览版', old: '远古版', fools: '愚人节版', other: '其他' };
const SKELETON_ROWS = 8;

/** 只取日期部分：2026-09-15T11:23:02+00:00 → 2026-09-15 */
const dateOf = (iso) => String(iso || '').slice(0, 10) || '—';

export async function mountGameDownload(host, { bridge, shell } = {}) {
  if (!host) throw new Error('mountGameDownload: 缺少宿主节点');
  if (!bridge) throw new Error('mountGameDownload: 缺少 bridge');

  const hooks = {
    latestVersion: qs(host, '[data-wmc-dl-latest-version]'),
    latestMeta: qs(host, '[data-wmc-dl-latest-meta]'),
    installAll: qs(host, '[data-wmc-dl-install-all]'),
    installIcon: qs(host, '[data-wmc-dl-install-icon]'),
    search: qs(host, '[data-wmc-dl-search]'),
    categorySlot: qs(host, '[data-wmc-dl-category]'),
    sourceSlot: qs(host, '[data-wmc-dl-source]'),
    refresh: qs(host, '[data-wmc-dl-refresh]'),
    count: qs(host, '[data-wmc-dl-count]'),
    list: qs(host, '[data-wmc-dl-list]'),
  };

  if (hooks.installIcon) hooks.installIcon.innerHTML = iconSvg('download', 18);

  const state = {
    source: 'official',
    category: 'release',
    query: '',
    items: [],          // 当前分类的完整列表（搜索走内存过滤，不再请求）
    latest: null,
    latestDetail: null,
    counts: null,
    total: 0,
    sourceLabel: '',
    fromCache: false,
    fallback: false,
    loading: true,
    error: '',
  };

  const cleanups = [];
  let requestToken = 0;

  /* ---------------------------------------------------------------- 下拉框（自定义，非原生） */
  const categorySelect = createSelect({
    items: CATEGORIES,
    value: state.category,
    ariaLabel: '版本分类',
    minWidth: 132,
    onChange: (value) => {
      if (value === state.category) return;
      state.category = value;
      load();
    },
  });
  const sourceSelect = createSelect({
    items: SOURCES,
    value: state.source,
    ariaLabel: '下载源',
    minWidth: 168,
    onChange: (value) => {
      if (value === state.source) return;
      state.source = value;
      load();                       // 主进程按源分别缓存，这里直接请求即可
    },
  });
  hooks.categorySlot?.append(categorySelect.element);
  hooks.sourceSlot?.append(sourceSelect.element);
  cleanups.push(() => { categorySelect.destroy(); sourceSelect.destroy(); });

  /* ---------------------------------------------------------------- 渲染：骨架屏 / 错误 / 空 */
  function renderSkeleton() {
    if (!hooks.list) return;
    hooks.list.replaceChildren(...Array.from({ length: SKELETON_ROWS }, () => el('div', { class: 'wmc-dl__skeleton' }, [
      el('div', { class: 'wmc-dl__bone' }),
      el('div', { class: 'wmc-dl__bone' }),
      el('div', { class: 'wmc-dl__bone' }),
      el('div', { class: 'wmc-dl__bone wmc-dl__bone--act' }),
    ])));
  }

  function renderError(error) {
    const message = String(error?.message || error);
    const noIpc = error?.code === 'NO_IPC' || error?.code === 'NO_METHOD';
    hooks.list?.replaceChildren(el('div', { class: 'wmc-dl__error' }, [
      el('div', { class: 'wmc-dl__errorTitle', text: noIpc ? '需要 Electron 主进程' : '版本清单获取失败' }),
      el('div', { text: message }),
      el('div', {
        class: 'wmc-dl__errorHint',
        text: noIpc
          ? '版本清单与安装包解析都在主进程完成（渲染进程不联网、也没有内置假数据）。请用 Electron 启动，并确认 preload 暴露了 wmc.versions.list。'
          : '可以点「刷新」重试，或在下拉框切换到 BMCLAPI 镜像（国内网络通常更稳）。',
      }),
    ]));
  }

  function renderEmpty() {
    hooks.list?.replaceChildren(el('div', {
      class: 'wmc-dl__empty',
      text: state.query ? `没有匹配「${state.query}」的版本` : '这个分类下暂时没有版本',
    }));
  }

  /* ---------------------------------------------------------------- 渲染：列表 */
  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    // 需求：搜索是前端内存过滤，所以这里不再发请求
    return q ? state.items.filter((v) => v.id.toLowerCase().includes(q)) : state.items;
  }

  function renderCount() {
    if (!hooks.count) return;
    const shown = visibleItems().length;
    hooks.count.replaceChildren(...[
      '共 ', el('b', { text: String(state.total || 0) }), ' 个版本',
      state.query ? `，匹配 ${shown} 个` : '',
      state.sourceLabel ? ` · 来源 ${state.sourceLabel}` : '',
      state.fromCache ? ' · 缓存' : '',
      state.fallback ? ' · 已自动降级到可用源' : '',
    ].filter(Boolean));
  }

  function renderList() {
    if (!hooks.list) return;
    const items = visibleItems();
    if (!items.length) { renderEmpty(); renderCount(); return; }

    hooks.list.replaceChildren(...items.map((version) => el('div', {
      class: 'wmc-dl__row',
      dataset: { id: version.id },
    }, [
      el('span', { class: 'wmc-dl__rowVer', text: version.id, attrs: { title: version.id } }),
      el('span', { class: `wmc-dl__tag wmc-dl__tag--${version.category}`, text: TAG_LABEL[version.category] || '其他' }),
      el('span', { class: 'wmc-dl__rowTime', text: dateOf(version.releaseTime) }),
      (() => {
        const btn = el('button', { class: 'wmc-dl__rowAct', attrs: { type: 'button' }, text: '安装' });
        cleanups.push(on(btn, 'click', () => openInstallDialog(version)));
        return btn;
      })(),
    ])));
    renderCount();
  }

  /* ---------------------------------------------------------------- 渲染：顶部大卡片 */
  function renderLatest() {
    const latest = state.latest?.release;
    if (hooks.latestVersion) {
      hooks.latestVersion.textContent = latest ? `最新正式版：${latest.id}` : '最新正式版：—';
      hooks.latestVersion.classList.toggle('wmc-dl__version--none', !latest);
    }
    if (hooks.installAll) hooks.installAll.disabled = !latest;
    if (!hooks.latestMeta) return;

    const chips = [];
    if (latest) {
      chips.push(el('span', { class: 'wmc-dl__chip' }, ['发布时间 ', el('b', { text: dateOf(latest.releaseTime) })]));
      chips.push(el('span', { class: 'wmc-dl__chip' }, ['类型 ', el('b', { text: '正式版' })]));
      const detail = state.latestDetail;
      chips.push(detail
        ? el('span', { class: 'wmc-dl__chip' }, ['需要 ', el('b', { text: `Java ${detail.javaVersion?.majorVersion || '未知'}` })])
        : el('span', { class: 'wmc-dl__chip', text: '正在读取安装信息…' }));
      if (detail) {
        chips.push(el('span', { class: 'wmc-dl__chip' }, ['依赖库 ', el('b', { text: `${detail.libraries} 个` })]));
      }
    } else {
      chips.push(el('span', { class: 'wmc-dl__chip wmc-dl__chip--warn', text: '没有读到正式版' }));
    }
    if (state.sourceLabel) chips.push(el('span', { class: 'wmc-dl__chip', text: state.sourceLabel }));
    hooks.latestMeta.replaceChildren(...chips);
  }

  /* ---------------------------------------------------------------- 数据加载（全部走主进程） */
  async function load({ force = false } = {}) {
    const token = ++requestToken;
    state.loading = true;
    state.error = '';
    renderSkeleton();
    if (hooks.count) hooks.count.textContent = '正在读取版本清单…';
    if (hooks.refresh) hooks.refresh.disabled = true;

    try {
      const data = await bridge.versionsList({
        source: state.source,
        category: state.category,
        force,
      });
      if (token !== requestToken) return;          // 竞态：只认最后一次

      state.items = data.items || [];
      state.latest = data.latest || null;
      state.counts = data.counts || null;
      state.total = data.total || 0;
      state.sourceLabel = data.sourceLabel || '';
      state.fromCache = !!data.fromCache;
      state.fallback = !!data.fallback;

      renderLatest();
      renderList();

      // 顶部卡片再补一条真实详情（Java 要求 / 依赖库数量），失败不影响列表
      const latestId = state.latest?.release?.id;
      if (latestId) {
        bridge.versionsDetail({ id: latestId, source: state.source })
          .then((detail) => {
            if (token !== requestToken) return;
            state.latestDetail = detail;
            renderLatest();
          })
          .catch(() => { /* 详情拿不到就不显示这几项 */ });
      }
    } catch (error) {
      if (token !== requestToken) return;
      state.error = String(error?.message || error);
      state.items = [];
      state.latest = null;
      renderLatest();
      renderError(error);
    } finally {
      if (token === requestToken) {
        state.loading = false;
        if (hooks.refresh) hooks.refresh.disabled = false;
      }
    }
  }

  /* ---------------------------------------------------------------- 安装：真实详情 → 确认 */
  async function openInstallDialog(version) {
    const id = version?.id || version;
    let detail = null;
    try {
      detail = await bridge.versionsDetail({ id, source: state.source });
    } catch (error) {
      toastErr('读取版本详情失败', String(error?.message || error));
      return;
    }

    const markBtn = el('button', { class: 'wmc-primaryBtn', attrs: { type: 'button' }, text: '设为目标版本' });
    const closeBtn = el('button', { class: 'wmc-ghostBtn wmc-ghostBtn--sm', attrs: { type: 'button' }, text: '关闭' });
    let dialog;
    on(closeBtn, 'click', () => dialog?.close());

    dialog = openWmcDialog({
      title: `安装 ${detail.id}`,
      hint: '这里展示的是从 Mojang 版本 JSON 实时读到的真实信息。完整的下载与落盘（client / libraries / assets 断点续传）在下一步接入下载队列；现在点「设为目标版本」会把它写进配置，首页与启动控制台会立刻显示这个版本。',
      actions: [markBtn, closeBtn],
      buildBody(body) {
        body.append(kvRow('版本号', detail.id));
        body.append(kvRow('类型', TAG_LABEL[detail.category] || detail.type));
        body.append(kvRow('发布时间', dateOf(detail.releaseTime)));
        body.append(kvRow('需要 Java', `${detail.javaVersion?.majorVersion || '未知'}${detail.javaVersion?.component ? `（${detail.javaVersion.component}）` : ''}`,
          detail.javaVersion?.majorVersion ? ' wmc-kv__val--ok' : ' wmc-kv__val--warn'));
        body.append(kvRow('资源索引', detail.assets || '—'));
        body.append(kvRow('依赖库', `${detail.libraries} 个`));
        body.append(kvRow('主类', detail.mainClass || '—', ' wmc-kv__val--mono'));
        body.append(kvRow('客户端包', detail.client ? `${(detail.client.size / 1048576).toFixed(1)} MB · sha1 ${String(detail.client.sha1).slice(0, 10)}…` : '—', ' wmc-kv__val--mono'));
      },
    });

    on(markBtn, 'click', async () => {
      markBtn.disabled = true;
      markBtn.textContent = '写入中…';
      try {
        await bridge.configPatch({ lastVersionId: detail.id });
        dialog.close();
        toastOk('已设为目标版本', `${detail.id} 已写入配置`);
      } catch (error) {
        markBtn.disabled = false;
        markBtn.textContent = '设为目标版本';
        toastErr('写入失败', String(error?.message || error));
      }
    });
  }

  /* ---------------------------------------------------------------- 事件绑定 */
  if (hooks.search) {
    const run = debounce(() => { renderList(); }, 220);
    cleanups.push(on(hooks.search, 'input', () => { state.query = hooks.search.value || ''; run(); }));
  }
  if (hooks.refresh) {
    cleanups.push(on(hooks.refresh, 'click', () => { toastInfo('正在刷新', '强制重新拉取版本清单'); load({ force: true }); }));
  }
  if (hooks.installAll) {
    cleanups.push(on(hooks.installAll, 'click', () => {
      const latest = state.latest?.release;
      if (!latest) { toastErr('没有可用版本', '还没读到最新正式版，先点刷新试试'); return; }
      openInstallDialog(latest);
    }));
  }

  /* ---------------------------------------------------------------- 首次加载 */
  renderSkeleton();
  await load();

  return {
    refresh: () => load({ force: true }),
    getState: () => ({ ...state, visible: visibleItems().length }),
    destroy() {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      requestToken += 1;
    },
  };
}