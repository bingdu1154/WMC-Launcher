/**
 * WMC 面板 · 下载中心
 * ---------------------------------------------------------------------------
 * - 左侧分类（金边卷轴 + 朱砂印章）
 * - 顶部工具栏：搜索 + 自定义下载源下拉 + 排序下拉
 * - 3~4 列卡片网格（CSS Grid auto-fill），触底自动加载 + 「加载更多」兜底
 * - 封面骨架屏 + 渐显；卡片悬停上浮；「获取」按钮朱砂红
 * - 下载进度实时显示在卡片上（订阅 bridge.onProgress）
 *
 * 用法：
 *   const panel = await mountDownloadCenter(document.querySelector('[data-wmc-dc]'), { bridge });
 *   panel.destroy();
 */
import { CustomSelect } from './wmc-custom-select.js';
import {
  debounce, el, formatBytes, formatCount, iconEl, iconSvg, middleEllipsis, qs, qsa, on,
} from './wmc-dom.js';
import { toastErr, toastInfo, toastOk } from './wmc-toast.js';

const DEFAULT_PAGE_SIZE = 24;

/* ============================================================================
   资源卡片工厂
   ---------------------------------------------------------------------------
   下载中心的卡片网格与首页「为你推荐」共用这一份实现，
   因此封面骨架屏 / 角标 / 两行简介 / 下载量与「获取」按钮在三处永远一致。
   ========================================================================== */

/** 把下载进度画到卡片上（progress 为 0~1） */
export function applyCardProgress(handle, progress) {
  const pct = Math.round((progress ?? 0) * 100);
  handle.node.classList.add('is-downloading');
  handle.progressFill.style.width = `${pct}%`;
  handle.getBtn.disabled = true;
  handle.getBtn.textContent = pct >= 100 ? '已安装' : `下载中 ${pct}%`;
  if (pct >= 100) {
    handle.node.classList.remove('is-downloading');
    handle.markInstalled();
  }
}

/**
 * 构造一张资源卡片。
 *
 * @param {object} item 资源对象（见 INTEGRATION.md 的数据契约）
 * @param {object} [options]
 * @param {number} [options.coverSkeletonMs] 封面载入后额外保留骨架的时间
 * @param {number} [options.progress]        已知进度（0~1），用于恢复下载中的状态
 * @param {(item:object, handle:object) => void} [options.onOpen]
 * @param {(item:object, handle:object) => void} [options.onDownload]
 * @param {boolean} [options.compact]        紧凑模式（首页推荐列用，不显示体积）
 * @returns {{ node:HTMLElement, item:object, getBtn:HTMLElement, progressFill:HTMLElement,
 *            setProgress:(p:number)=>void, markInstalled:()=>void, destroy:()=>void }}
 */
export function createResourceCard(item, options = {}) {
  const {
    coverSkeletonMs = 0, progress = null, onOpen = null, onDownload = null, compact = false,
  } = options;

  const coverSkeleton = el('div', { class: 'wmc-skeleton wmc-mod__coverSkeleton' });
  const img = el('img', {
    class: 'wmc-mod__img',
    attrs: { alt: item.title, loading: 'lazy', decoding: 'async', draggable: 'false' },
  });

  const badgeCls = `wmc-mod__badge wmc-mod__badge--${item.sourceClass || 'curseforge'}`;
  const cover = el('div', { class: 'wmc-mod__cover' }, [
    img,
    coverSkeleton,
    el('span', { class: badgeCls, text: item.sourceLabel || '社区' }),
    item.installed ? el('span', { class: 'wmc-mod__flag', text: '已安装' }) : null,
  ]);

  // 骨架 → 渐显：图片 onload 之后再切换，网络慢时不会留白
  const finishCover = () => {
    coverSkeleton.classList.add('is-done');
    img.classList.add('is-loaded');
  };
  const showCoverFallback = () => {
    coverSkeleton.classList.add('is-done');
    img.remove();
    if (!cover.querySelector('.wmc-mod__coverFallback')) {
      cover.append(el('div', { class: 'wmc-mod__coverFallback', text: item.title.charAt(0) || '?' }));
    }
  };
  img.addEventListener('load', () => {
    if (coverSkeletonMs > 0) setTimeout(finishCover, coverSkeletonMs);
    else finishCover();
  }, { once: true });
  img.addEventListener('error', showCoverFallback, { once: true });

  // 真正把封面挂上去；后端没给封面时直接走兜底，避免一直停在骨架屏
  if (item.cover) img.src = item.cover;
  else showCoverFallback();

  const dlIcon = el('span', { class: 'wmc-mod__dlIcon' });
  dlIcon.innerHTML = iconSvg('download', 12);

  const progressFill = el('div', { class: 'wmc-mod__progressFill' });
  const getBtn = el('button', {
    class: 'wmc-btn wmc-btn--primary wmc-mod__get',
    attrs: { type: 'button' },
    text: item.installed ? '已安装' : '获取',
  });
  if (item.installed) getBtn.disabled = true;

  const body = el('div', { class: 'wmc-mod__bd' }, [
    el('h3', { class: 'wmc-mod__title', text: item.title }),
    el('div', { class: 'wmc-mod__author' }, ['作者 ', el('b', { text: item.author || '匿名' })]),
    el('p', { class: 'wmc-mod__desc', text: item.desc || '', attrs: { title: item.desc || '' } }),
    item.tags?.length
      ? el('div', { class: 'wmc-mod__tags' }, item.tags.map((tag) => el('span', { class: 'wmc-chip', text: tag })))
      : null,
  ]);

  const footer = el('div', { class: 'wmc-mod__ft' }, [
    el('span', { class: 'wmc-mod__dl', attrs: { title: `下载量 ${item.downloads}` } },
      [dlIcon, formatCount(item.downloads)]),
    compact ? null : el('span', {
      class: 'wmc-mod__size wmc-mono',
      text: item.sizeBytes ? formatBytes(item.sizeBytes) : '',
    }),
    getBtn,
  ]);

  const node = el('article', {
    class: 'wmc-mod',
    attrs: { tabindex: '0', role: 'group', 'aria-label': item.title },
    dataset: { id: item.id },
  }, [
    cover,
    body,
    footer,
    el('div', { class: 'wmc-mod__progress' }, [progressFill]),
  ]);

  const handle = {
    node, item, getBtn, progressFill, cover, img,
    setProgress: (value) => applyCardProgress(handle, value),
    markInstalled() {
      item.installed = true;
      getBtn.disabled = true;
      getBtn.textContent = '已安装';
      node.classList.remove('is-downloading');
      if (!cover.querySelector('.wmc-mod__flag')) {
        cover.append(el('span', { class: 'wmc-mod__flag', text: '已安装' }));
      }
    },
    destroy() { node.remove(); },
  };

  // 点卡片打开详情（或交给宿主处理）
  node.addEventListener('click', (event) => {
    if (event.target.closest('.wmc-mod__get')) return;
    if (onOpen) onOpen(item, handle);
    else toastInfo(item.title, `${item.sourceLabel} · 作者 ${item.author} · ${formatCount(item.downloads)} 次下载`);
  });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === node && onOpen) onOpen(item, handle);
  });
  getBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    onDownload?.(item, handle);
  });

  // 恢复已知进度（例如从别的页面切回来）
  if (progress != null) applyCardProgress(handle, progress);
  return handle;
}

export async function mountDownloadCenter(root, options = {}) {
  if (!root) throw new Error('mountDownloadCenter: 缺少根节点');
  const bridge = options.bridge;
  if (!bridge) throw new Error('mountDownloadCenter: 缺少 bridge');

  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : null;
  // mock 模式下给封面留一点点骨架屏时间，让「渐显」效果可被看见；真实 IPC 下为 0
  const coverSkeletonMs = bridge.mode === 'mock' ? 180 : 0;

  /* ------------------------------------------------------------ 抓取骨架节点 */
  const nodes = {
    cats: qs(root, '[data-wmc-dc-cats]'),
    source: qs(root, '[data-wmc-dc-source]'),
    sort: qs(root, '[data-wmc-dc-sort]'),
    meta: qs(root, '[data-wmc-dc-meta]'),
    grid: qs(root, '[data-wmc-dc-grid]'),
    scroll: qs(root, '[data-wmc-dc-scroll]'),
    search: qs(root, '[data-wmc-dc-search]'),
    searchIcon: qs(root, '[data-wmc-icon="search"]'),
  };
  for (const [name, node] of Object.entries(nodes)) {
    if (!node && name !== 'searchIcon') throw new Error(`mountDownloadCenter: 缺少节点 ${name}`);
  }
  if (nodes.searchIcon) nodes.searchIcon.innerHTML = iconSvg('search', 14);

  const cleanups = [];
  const cards = new Map();          // itemId → { node, fill, btn, item }
  const progressByItem = new Map(); // itemId → progress

  const state = {
    category: options.category || 'mod',
    source: 'all',
    sort: 'popular',
    query: '',
    page: 0,
    total: 0,
    hasMore: true,
    loading: false,
    requestToken: 0,
  };

  /* ------------------------------------------------------------ 工具栏下拉 */
  const [sourceItems, sortItems, categories] = await Promise.all([
    bridge.sources(),
    bridge.sorts(),
    bridge.categories(),
  ]);

  const sourceSelect = new CustomSelect({
    items: [{ value: 'all', label: '全部来源' }, ...sourceItems],
    value: 'all',
    ariaLabel: '下载源',
    minWidth: '170px',
    onChange: (value) => { state.source = value; reload(); },
  });
  const sortSelect = new CustomSelect({
    items: sortItems,
    value: 'popular',
    ariaLabel: '排序方式',
    minWidth: '140px',
    onChange: (value) => { state.sort = value; reload(); },
  });
  nodes.source.append(sourceSelect.element);
  nodes.sort.append(sortSelect.element);
  cleanups.push(() => { sourceSelect.destroy(); sortSelect.destroy(); });

  /* ------------------------------------------------------------ 左侧分类 */
  function renderCategories() {
    const frag = document.createDocumentFragment();
    for (const category of categories) {
      const seal = el('span', { class: 'wmc-dc__seal', text: category.name.charAt(0) });
      const node = el('button', {
        class: 'wmc-dc__cat' + (category.id === state.category ? ' wmc-dc__cat--active' : ''),
        attrs: { type: 'button', 'aria-pressed': category.id === state.category ? 'true' : 'false' },
        dataset: { category: category.id },
      }, [
        el('span', { class: 'wmc-dc__catIcon', text: category.icon || '📁' }),
        el('span', { class: 'wmc-dc__catName', text: category.name }),
        el('span', { class: 'wmc-dc__catCount', text: category.count != null ? String(category.count) : '' }),
        seal,
      ]);
      frag.append(node);
    }
    nodes.cats.replaceChildren(frag);
  }

  async function onCategoryClick(event) {
    const btn = event.target.closest?.('.wmc-dc__cat');
    if (!btn) return;
    const { category } = btn.dataset;
    if (!category || category === state.category) return;
    state.category = category;
    for (const node of qsa(nodes.cats, '.wmc-dc__cat')) {
      const active = node.dataset.category === category;
      node.classList.toggle('wmc-dc__cat--active', active);
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    reload();
  }
  cleanups.push(on(nodes.cats, 'click', onCategoryClick));

  /* ------------------------------------------------------------ 骨架卡片 */
  function skeletonCard() {
    return el('article', { class: 'wmc-mod wmc-mod--skeleton', attrs: { 'aria-hidden': 'true' } }, [
      el('div', { class: 'wmc-mod__cover' }, [
        el('div', { class: 'wmc-skeleton wmc-mod__coverSkeleton' }),
      ]),
      el('div', { class: 'wmc-mod__bd' }, [
        el('div', { class: 'wmc-skeleton wmc-skeleton--title' }),
        el('div', { class: 'wmc-skeleton wmc-skeleton--line' }),
        el('div', { class: 'wmc-skeleton wmc-skeleton--line short' }),
      ]),
    ]);
  }

  function renderSkeletons(count = 8) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) frag.append(skeletonCard());
    nodes.grid.replaceChildren(frag);
  }

  /* ------------------------------------------------------------ 卡片 */
  /** 统一走卡片工厂（与首页推荐流同一份实现），并登记到进度表里 */
  function createCard(item) {
    const handle = createResourceCard(item, {
      coverSkeletonMs,
      progress: progressByItem.get(item.id) ?? null,
      onOpen: (it, h) => { if (onOpen) onOpen(it, h.node); },
      onDownload: (it, h) => startDownload(it, h),
    });
    cards.set(item.id, handle);
    return handle.node;
  }

  /* ------------------------------------------------------------ 下载 */
  async function startDownload(item, handle) {
    const { getBtn } = handle;
    getBtn.classList.add('is-busy');
    getBtn.textContent = '准备中…';
    try {
      const result = await bridge.startDownload(item);
      if (result?.id) item.downloadId = result.id;
      handle.node.classList.add('is-downloading');
      getBtn.textContent = '下载中 0%';
      toastInfo('已开始下载', `${item.title} · ${item.sizeBytes ? formatBytes(item.sizeBytes) : '体积未知'}`);
    } catch (error) {
      getBtn.classList.remove('is-busy');
      getBtn.textContent = '获取';
      toastErr('下载失败', String(error?.message || error));
    }
  }

  // 进度订阅：用 itemId 关联到卡片（切换分类后回来仍然能恢复）
  const offProgress = bridge.onProgress((payload) => {
    if (!payload) return;
    const itemId = payload.itemId || payload.id;
    if (itemId == null) return;
    progressByItem.set(itemId, payload.progress ?? 0);
    const entry = cards.get(itemId);
    if (!entry) return;
    applyCardProgress(entry, payload.progress ?? 0);
    if ((payload.progress ?? 0) >= 1) {
      entry.getBtn.classList.remove('is-busy');
      toastOk('下载完成', `${entry.item.title} 已加入版本库`);
      progressByItem.delete(itemId);
    }
  });
  cleanups.push(offProgress);

  /* ------------------------------------------------------------ 分页/触底 */
  const moreWrap = el('div', { class: 'wmc-dc__more' });
  const moreBtn = el('button', {
    class: 'wmc-btn wmc-btn--gold',
    attrs: { type: 'button' },
    text: '加载更多',
  });
  const dots = el('div', { class: 'wmc-dots', attrs: { 'aria-hidden': 'true' } }, [
    el('i'), el('i'), el('i'),
  ]);
  const moreText = el('span', { class: 'wmc-muted', text: '' });
  const sentinel = el('div', { class: 'wmc-dc__sentinel' });
  moreWrap.append(moreBtn, dots, moreText, sentinel);
  moreWrap.hidden = true;

  function updateMoreState() {
    moreWrap.hidden = !state.loading && !state.hasMore;
    dots.hidden = !state.loading;
    moreBtn.hidden = state.loading || !state.hasMore;
    moreText.textContent = state.loading
      ? '正在加载…'
      : (state.hasMore ? '' : `已经到底了 · 共 ${state.total} 项`);
  }

  moreBtn.addEventListener('click', () => { if (!state.loading) loadNext(); });

  // IntersectionObserver 触底加载；不支持时退化为按钮
  let observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && state.hasMore && !state.loading) loadNext();
      }
    }, { root: nodes.scroll || null, rootMargin: '320px 0px', threshold: 0.01 });
    observer.observe(sentinel);
  }
  cleanups.push(() => observer?.disconnect());

  /* ------------------------------------------------------------ 数据加载 */
  function updateMeta() {
    const categoryName = categories.find((c) => c.id === state.category)?.name || '';
    nodes.meta.textContent = state.total
      ? `${categoryName} · 共 ${state.total} 项 · 已显示 ${cards.size}`
      : '';
  }

  async function loadNext() {
    state.loading = true;
    updateMoreState();
    const token = (state.requestToken += 1);
    const nextPage = state.page + 1;
    try {
      const result = await bridge.search({
        category: state.category,
        source: state.source,
        query: state.query,
        sort: state.sort,
        page: nextPage,
        pageSize,
      });
      if (token !== state.requestToken) return; // 过期响应直接丢弃，避免闪回
      state.page = result.page || nextPage;
      state.total = result.total ?? 0;
      state.hasMore = !!result.hasMore;

      const list = result.items || [];
      if (nextPage === 1) nodes.grid.replaceChildren();

      if (nextPage === 1 && list.length === 0) {
        nodes.grid.append(el('div', { class: 'wmc-empty' }, [
          el('div', { class: 'wmc-empty__icon', text: '🪶' }),
          el('div', {
            class: 'wmc-empty__text',
            text: state.query ? `没有找到与「${state.query}」相关的资源，换个关键词试试` : '这个分类暂时没有内容',
          }),
        ]));
      } else {
        const frag = document.createDocumentFragment();
        for (const item of list) {
          const existing = cards.get(item.id);
          if (existing) { frag.append(existing.node); continue; }
          frag.append(createCard(item));
        }
        nodes.grid.append(frag);
      }
      nodes.grid.append(moreWrap);
      updateMeta();
    } catch (error) {
      toastErr('加载失败', String(error?.message || error));
      nodes.grid.append(el('div', { class: 'wmc-empty' }, [
        el('div', { class: 'wmc-empty__icon', text: '⚠' }),
        el('div', { class: 'wmc-empty__text', text: '加载出错，请稍后重试或切换下载源' }),
      ]));
    } finally {
      if (token === state.requestToken) {
        state.loading = false;
        updateMoreState();
      }
    }
  }

  function reload() {
    state.page = 0;
    state.hasMore = true;
    state.total = 0;
    state.requestToken += 1;      // 让在途请求作废
    cards.clear();
    renderSkeletons(8);
    state.loading = false;
    loadNext();
  }

  const onSearch = debounce((value) => {
    state.query = value;
    reload();
  }, 320);
  cleanups.push(on(nodes.search, 'input', (event) => onSearch(event.target.value.trim())));
  cleanups.push(() => onSearch.cancel?.());

  /* ------------------------------------------------------------ 启动 */
  renderCategories();
  reload();

  return {
    /** 重新加载当前分类 */
    refresh: reload,
    /** 切换分类（外部调用，例如从托盘/快捷方式跳转） */
    setCategory(id) {
      if (!categories.some((c) => c.id === id)) return;
      state.category = id;
      renderCategories();
      reload();
    },
    getState: () => ({ ...state, rendered: cards.size }),
    /** 调试/自动化测试句柄（例如截图时展开下拉框） */
    debug: { sourceSelect, sortSelect, skeletonCard, createCard },
    destroy() {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      cards.clear();
      nodes.grid.replaceChildren();
    },
  };
}

/** 供外部复用：把路径中间省略（宿主页面展示目录时可用） */
export const ellipsisPath = middleEllipsis;