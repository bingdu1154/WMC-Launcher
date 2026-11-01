/**
 * WMC 启动器 · 首页（Dashboard）—— 水墨青绿
 * ---------------------------------------------------------------------------
 * 页面结构写在 app.html 的 <template data-wmc-template="home"> 里（便于整段搬走），
 * 这里只负责装配数据与交互：
 *   · 主面板：欢迎语 + 状态栏（版本 / 内存 / Java）+ 印章「启动游戏」
 *   · 六宫格：磨砂微光卡片；「环境体检」「存档速览」是特色功能
 *   · 为你推荐：复用下载中心的卡片工厂（封面渐变 + 小图标）
 *   · 右侧：水墨黄历 / 今日运势（信笺 + 折扇）
 *
 * 逻辑底线：
 *   · **没有检测到游戏版本时一律显示「没有版本」**，绝不写死任何具体版本号；
 *   · 点「启动游戏」时若没有版本，会引导去「游戏下载」页。
 */
import { createResourceCard } from './wmc-download-center.js';
import { el, formatBytes, iconSvg, on, qs } from './wmc-dom.js';
import { memoryAdvice } from './wmc-runtime-panel.js';
import { toastErr, toastInfo, toastOk } from './wmc-toast.js';

/** 首页推荐列在 mock 模式下给封面留一点骨架屏时间 */
const COVER_SKELETON_MS = 160;
/** 浮层关闭动画时长（与 CSS 的 --wmc-dur-slow 对齐） */
const SHEET_ANIM_MS = 320;
/** 没有版本时的明确文案（底线要求，别改成别的占位） */
const NO_VERSION_TEXT = '没有版本';

/* ============================================================================
   环境体检：纯函数，便于单测（自检脚本会直接调用它）
   ---------------------------------------------------------------------------
   只依据手上已有的真实数据做判断，不编造结论：
     · Java 运行时 —— 来自 bridge.javaList()
     · 内存分配   —— 复用运行环境面板的 memoryAdvice()，全站同一套阈值
     · 缺失依赖   —— 需要版本清单（任务 2 接入），当前如实标注为「待接入」
   ========================================================================== */
export function buildHealthReport({ config = {}, system = {}, javaList = [] } = {}) {
  const rows = [];

  const javas = Array.isArray(javaList) ? javaList.filter((j) => j && j.ok !== false) : [];
  rows.push(javas.length
    ? {
      key: 'Java 运行时',
      value: `${javas.length} 个可用 · ${javas[0].name || 'Java'}${javas[0].vendor ? ` · ${javas[0].vendor}` : ''}`,
      level: 'ok',
    }
    : { key: 'Java 运行时', value: '未检测到，启动前需要先装一个 Java 21', level: 'warn' });

  const maxMb = Number(config.maxMemoryMb) || 0;
  const totalMb = Number(system.totalMemMb) || 0;
  const advice = maxMb && totalMb ? memoryAdvice(maxMb, totalMb, system.freeMemMb) : null;
  rows.push({
    key: '内存分配',
    value: maxMb
      ? `${maxMb} MB${advice?.text ? ` · ${advice.text}` : ''}`
      : '未设置，将按物理内存自动推荐',
    level: advice?.level === 'warn' ? 'warn' : (advice?.level === 'gold' ? 'info' : 'ok'),
  });

  const version = String(config.lastVersionId || '').trim();
  rows.push({
    key: '缺失依赖',
    value: version
      ? `${version} 的依赖清单需要版本库（任务 2 接入后逐项校验）`
      : `${NO_VERSION_TEXT}：选择版本后再校验 libraries / assets`,
    level: version ? 'info' : 'warn',
  });

  return {
    rows,
    ok: rows.filter((r) => r.level === 'ok').length,
    warn: rows.filter((r) => r.level === 'warn').length,
  };
}

/* ============================================================================
   页面装配
   ========================================================================== */
export async function mountHome(host, { bridge, shell } = {}) {
  if (!host) throw new Error('mountHome: 缺少宿主节点');
  if (!bridge) throw new Error('mountHome: 缺少 bridge');

  const hooks = {
    sub: qs(host, '[data-wmc-hero-sub]'),
    status: qs(host, '[data-wmc-hero-status]'),
    launch: qs(host, '[data-wmc-launch]'),
    launchIcon: qs(host, '[data-wmc-launch-icon]'),
    secondary: qs(host, '[data-wmc-hero-secondary]'),
    quicks: qs(host, '[data-wmc-quicks]'),
    recs: qs(host, '[data-wmc-recs]'),
    recsMore: qs(host, '[data-wmc-recs-more]'),
    almanacTitle: qs(host, '[data-wmc-almanac-title]'),
    almanacDate: qs(host, '[data-wmc-almanac-date]'),
    almanacRows: qs(host, '[data-wmc-almanac-rows]'),
    almanacNote: qs(host, '[data-wmc-almanac-note]'),
  };

  const cleanups = [];
  const cardHandles = new Map();   // itemId → 卡片句柄（进度回填）
  let openSheetClose = null;

  if (hooks.launchIcon) hooks.launchIcon.innerHTML = iconSvg('play', 16);

  /* ---------------------------------------------------------------- 数据 */
  const [config, system, javaList, account] = await Promise.all([
    bridge.configGet(),
    bridge.systemInfo(),
    bridge.javaList(false),
    bridge.account(),
  ]);

  const version = String(config?.lastVersionId || '').trim();
  const memory = Number(config?.maxMemoryMb) || 0;
  const java = Array.isArray(javaList) && javaList.length ? javaList[0] : null;
  const hasVersion = version.length > 0;

  /* ---------------------------------------------------------------- 主面板 */
  if (hooks.sub) {
    hooks.sub.textContent = `欢迎回来，${account?.name || '冒险者'} · 当前版本 ${hasVersion ? version : NO_VERSION_TEXT} · 一切就绪`;
  }

  if (hooks.status) {
    const chip = (label, value, warn = false) => el('span', {
      class: `wmc-hero__chip${warn ? ' wmc-hero__chip--warn' : ''}`,
    }, value ? [`${label} `, el('b', { text: value })] : [label]);
    hooks.status.replaceChildren(
      // 没有版本时如实显示「没有版本」，不编造版本号
      hasVersion ? chip('版本', version) : chip(NO_VERSION_TEXT, '', true),
      chip('内存', memory ? `${memory} MB` : '自动'),
      java
        ? chip('Java', `${String(java.name).replace(/^Java\s?/, '')} · ${java.vendor || '未知'}`)
        : chip('Java 未检测到', '', true),
    );
  }

  async function launchGame() {
    if (!hasVersion) {
      toastInfo('还没有可用版本', '先去「游戏下载」安装一个版本，再回来启动。');
      shell?.navigate('game');
      return;
    }
    if (hooks.launch?.disabled) return;
    const original = hooks.launch.textContent;
    hooks.launch.disabled = true;
    hooks.launch.textContent = '正在准备…';
    try {
      const result = await bridge.launchGame({ version, account: account?.id });
      if (result?.started === false) {
        toastInfo('启动流程待接入', result.reason === 'mock'
          ? '界面已就绪：任务 2 接入版本清单后，这里会走「校验 Java → 补全文件 → 启动」的真实流程。'
          : String(result.reason || '未启动'));
      }
    } catch (error) {
      toastErr('启动失败', String(error?.message || error));
    } finally {
      hooks.launch.disabled = false;
      hooks.launch.textContent = original;
    }
  }

  if (hooks.launch) cleanups.push(on(hooks.launch, 'click', launchGame));
  if (hooks.secondary) cleanups.push(on(hooks.secondary, 'click', () => shell?.navigate('game')));

  /* ---------------------------------------------------------------- 六宫格 */
  const quickEntries = await bridge.quickEntries();
  if (hooks.quicks) {
    hooks.quicks.replaceChildren(...quickEntries.map((entry) => {
      const icon = el('span', { class: 'wmc-quick__icon' });
      icon.innerHTML = iconSvg(entry.icon, 18);
      const node = el('button', {
        class: 'wmc-quick',
        attrs: { type: 'button', title: entry.desc },
      }, [
        icon,
        el('span', { class: 'wmc-quick__name', text: entry.name }),
        el('span', { class: 'wmc-quick__desc', text: entry.desc }),
        entry.tag ? el('span', { class: 'wmc-quick__tag', text: entry.tag }) : null,
      ]);
      cleanups.push(on(node, 'click', () => {
        if (entry.action === 'health') openHealthSheet();
        else if (entry.action === 'worlds') openWorldsSheet();
        else if (shell?.getPageMeta?.(entry.id)) shell.navigate(entry.id);
        else toastInfo(entry.name, `${entry.name}会在后续任务接入`);
      }));
      return node;
    }));
  }

  /* ---------------------------------------------------------------- 推荐流 */
  const recGrid = hooks.recs ? qs(hooks.recs, '.wmc-home__recGrid') : null;
  if (hooks.recsMore) cleanups.push(on(hooks.recsMore, 'click', () => shell?.navigate('mod')));

  if (recGrid) {
    try {
      const items = await bridge.recommended(4);
      recGrid.replaceChildren(...items.map((item) => {
        const handle = createResourceCard(item, {
          coverSkeletonMs: bridge.mode === 'mock' ? COVER_SKELETON_MS : 0,
          compact: true,
          onOpen: (it) => toastInfo(it.title, `${it.sourceLabel} · 作者 ${it.author} · ${it.downloads.toLocaleString('zh-CN')} 次下载`),
          onDownload: async (it, h) => {
            h.getBtn.classList.add('is-busy');
            h.getBtn.textContent = '准备中…';
            try {
              await bridge.startDownload(it);
              h.node.classList.add('is-downloading');
              h.getBtn.textContent = '下载中 0%';
            } catch (error) {
              h.getBtn.classList.remove('is-busy');
              h.getBtn.textContent = '获取';
              toastErr('下载失败', String(error?.message || error));
            }
          },
        });
        cardHandles.set(item.id, handle);
        return handle.node;
      }));
    } catch (error) {
      toastErr('推荐加载失败', String(error?.message || error));
    }
  }

  // 下载进度回填（与下载中心同一套 onProgress 协议）
  cleanups.push(bridge.onProgress((payload) => {
    const handle = cardHandles.get(payload?.itemId);
    if (!handle) return;
    handle.setProgress(payload.progress ?? 0);
    if ((payload.progress ?? 0) >= 1) handle.getBtn.classList.remove('is-busy');
  }));

  /* ---------------------------------------------------------------- 水墨黄历 */
  const fortune = await bridge.fortune();
  if (hooks.almanacTitle) hooks.almanacTitle.textContent = `水墨黄历 · ${fortune.level}`;
  if (hooks.almanacDate) hooks.almanacDate.textContent = `${fortune.date} · 幸运值 ${fortune.luck}`;
  if (hooks.almanacRows) {
    const rows = [
      { key: '宜', text: fortune.good.join('，'), cls: 'wmc-almanac__val--good' },
      { key: '忌', text: fortune.bad.join('，'), cls: 'wmc-almanac__val--bad' },
    ];
    hooks.almanacRows.replaceChildren(...rows.map((row) => el('div', { class: 'wmc-almanac__row' }, [
      el('span', { class: 'wmc-almanac__key', text: row.key }),
      el('span', { class: `wmc-almanac__val ${row.cls}`, text: row.text }),
    ])));
  }
  if (hooks.almanacNote) hooks.almanacNote.textContent = fortune.note;

  /* ---------------------------------------------------------------- 信笺浮层 */
  function openSheet({ title, buildBody, hint }) {
    closeSheet();
    const sheet = el('div', {
      // 浮层挂在 <body> 上（避免被父级 overflow 裁切），因此必须自带 .wmc-scope
      // 才能继承设计令牌 —— 否则 var(--wmc-*) 全部失效，颜色会变成透明。
      class: 'wmc-sheet wmc-scope',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    });

    const closeBtn = el('button', {
      class: 'wmc-sheet__close',
      attrs: { type: 'button', 'aria-label': '关闭' },
    });
    closeBtn.innerHTML = iconSvg('close', 14);

    const body = el('div', { class: 'wmc-sheet__bd' });
    buildBody(body);

    const panel = el('div', { class: 'wmc-sheet__panel' }, [
      el('div', { class: 'wmc-sheet__hd' }, [
        el('span', { class: 'wmc-sheet__title', text: title }),
        closeBtn,
      ]),
      body,
      hint ? el('div', { class: 'wmc-sheet__hint', text: hint }) : null,
    ]);

    sheet.append(panel);
    document.body.append(sheet);
    // 下一帧再加 is-open，保证过渡动画真的播起来
    requestAnimationFrame(() => sheet.classList.add('is-open'));

    const onKey = (event) => { if (event.key === 'Escape') closeSheet(); };
    document.addEventListener('keydown', onKey);
    const offMask = on(sheet, 'mousedown', (event) => { if (event.target === sheet) closeSheet(); });
    const offClose = on(closeBtn, 'click', closeSheet);

    openSheetClose = () => {
      offMask();
      offClose();
      document.removeEventListener('keydown', onKey);
      sheet.classList.remove('is-open');
      setTimeout(() => sheet.remove(), SHEET_ANIM_MS);
      openSheetClose = null;
    };
    closeBtn.focus?.();
    return sheet;
  }

  function closeSheet() {
    if (openSheetClose) openSheetClose();
  }

  /* ---- 特色功能一：环境体检 ---- */
  function openHealthSheet() {
    const report = buildHealthReport({ config, system, javaList });
    openSheet({
      title: '环境体检',
      hint: '体检只做只读检测，不会修改任何文件。Java 与内存为实时读取的真实数据；依赖清单会在任务 2 接入版本库后逐项校验。',
      buildBody(body) {
        const wrap = el('div', { class: 'wmc-health' });
        wrap.append(...report.rows.map((row) => el('div', { class: 'wmc-health__row' }, [
          el('span', { class: 'wmc-health__key', text: row.key }),
          el('span', {
            class: `wmc-health__val${row.level === 'ok' ? ' wmc-health__val--ok' : ''}${row.level === 'warn' ? ' wmc-health__val--warn' : ''}`,
            text: row.value,
          }),
          el('span', {
            class: `wmc-health__dot${row.level === 'warn' ? ' wmc-health__dot--warn' : ''}`,
            attrs: { 'aria-hidden': 'true' },
          }),
        ])));
        body.append(wrap);
        if (report.warn === 0) toastOk('体检完成', '一切正常，可以放心开新档');
        else toastInfo('体检完成', `有 ${report.warn} 项需要处理`);
      },
    });
  }

  /* ---- 特色功能二：存档速览 ---- */
  function openWorldsSheet() {
    openSheet({
      title: '存档速览',
      hint: '数据来自 .minecraft/saves：按 level.dat 的最后游玩时间排序取最近 3 个世界；没有存档时这里会明确显示「暂无游玩记录」。',
      buildBody(body) {
        const list = el('div', { class: 'wmc-worlds' });
        list.append(el('div', { class: 'wmc-sheet__hint', text: '正在读取存档…' }));
        body.append(list);

        bridge.recentWorlds(3).then((worlds) => {
          if (!worlds?.length) {
            list.replaceChildren(el('div', { class: 'wmc-worlds__empty', text: '暂无游玩记录' }));
            return;
          }
          list.replaceChildren(...worlds.map((world) => {
            const icon = el('span', { class: 'wmc-world__icon', attrs: { 'aria-hidden': 'true' } });
            icon.innerHTML = iconSvg('map', 18);
            const meta = [
              world.version, world.lastPlayed,
              world.playtime ? `游玩 ${world.playtime}` : null,
              world.sizeBytes ? formatBytes(world.sizeBytes) : null,
            ].filter(Boolean).join(' · ');

            const act = el('button', { class: 'wmc-world__act', attrs: { type: 'button' }, text: '打开目录' });
            act.addEventListener('click', async () => {
              if (!world.dir) {
                toastInfo('打开目录', '接入主进程后会直接打开该存档所在文件夹');
                return;
              }
              const done = await bridge.openPath(world.dir);
              if (!done) toastErr('打开失败', world.dir);
            });

            return el('div', { class: 'wmc-world' }, [
              icon,
              el('div', {}, [
                el('div', { class: 'wmc-world__name', text: world.name }),
                el('div', { class: 'wmc-world__meta', text: meta || '—' }),
              ]),
              act,
            ]);
          }));
        }).catch((error) => {
          list.replaceChildren(el('div', { class: 'wmc-sheet__hint', text: `读取存档失败：${error?.message || error}` }));
        });
      },
    });
  }

  /* ---------------------------------------------------------------- 卸载 */
  return {
    destroy() {
      closeSheet();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      cardHandles.clear();
      if (hooks.quicks) hooks.quicks.replaceChildren();
      if (recGrid) recGrid.replaceChildren();
    },
  };
}