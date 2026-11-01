/**
 * WMC 面板 · 运行环境
 * ---------------------------------------------------------------------------
 * 分组卡片（带纸张纹理）+ 「左标签 / 右值」两栏 + 状态指示：
 *   - 正常 → 青竹绿或金色；异常/警告 → 朱砂红
 * - 下载源同样使用自定义下拉，面板内不出现任何系统原生控件
 * - 内存：自绘步进器 + 金色内存条（不使用 <input type="range">）
 *
 * 用法：
 *   const panel = await mountRuntimePanel(document.querySelector('[data-wmc-env]'), { bridge });
 */
import { CustomSelect } from './wmc-custom-select.js';
import {
  clamp, el, iconEl, iconSvg, middleEllipsis, on, qs,
} from './wmc-dom.js';
import { toastErr, toastInfo, toastOk } from './wmc-toast.js';

const MEM_STEP_MB = 512;
const MEM_MIN_MB = 1024;
const RESERVED_FOR_SYSTEM_MB = 2048;

/** 内存推荐：与 JavaFX 版启动器同一套启发式，便于单测 */
export function recommendMemoryMb(totalMb) {
  const total = Number(totalMb) || 8192;
  let base;
  if (total <= 4096) base = 1024;
  else if (total <= 8192) base = 3072;
  else if (total <= 16384) base = 4096;
  else if (total <= 32768) base = 6144;
  else base = 8192;
  return clamp(Math.round(base / MEM_STEP_MB) * MEM_STEP_MB, MEM_MIN_MB, hardMaxMb(total));
}

/** 安全上限：物理内存 - 2GB（给系统留活路） */
export function hardMaxMb(totalMb) {
  const total = Number(totalMb) || 8192;
  return Math.max(MEM_MIN_MB, total - RESERVED_FOR_SYSTEM_MB);
}

/**
 * 内存健康度判断（纯函数，便于单测）
 * @returns {{level:'ok'|'gold'|'warn', text:string}}
 */
export function memoryAdvice(maxMb, totalMb, freeMb) {
  const hardMax = hardMaxMb(totalMb);
  const recommended = recommendMemoryMb(totalMb);
  if (!maxMb || maxMb < MEM_MIN_MB) {
    return { level: 'warn', text: `分配过小，1.13+ 的整合包可能直接闪退（建议至少 ${MEM_MIN_MB} MB）` };
  }
  if (maxMb > hardMax) {
    return { level: 'warn', text: `超过安全上限 ${hardMax} MB，可能导致系统换页、游戏反而更卡` };
  }
  if (freeMb != null && maxMb > freeMb) {
    return { level: 'gold', text: `当前可用内存仅 ${freeMb} MB，低于分配值；建议先关闭其它占内存的程序` };
  }
  if (maxMb > recommended + MEM_STEP_MB) {
    return { level: 'gold', text: `略高于推荐值 ${recommended} MB，大型整合包可以这样设置` };
  }
  return { level: 'ok', text: `推荐 ${recommended} MB（已为系统预留 2 GB）` };
}

/** Java 健康度判断（纯函数） */
export function javaAdvice(java, list) {
  if (!list || list.length === 0) {
    return { level: 'warn', text: '没有检测到任何 Java 运行时，请手动指定 java.exe 路径' };
  }
  if (!java) {
    return { level: 'gold', text: '未指定 Java，将由启动器自动选择（建议显式指定以避免版本不符）' };
  }
  if (java.ok === false) {
    return { level: 'warn', text: java.reason || '该 Java 版本不适用于当前游戏版本' };
  }
  return { level: 'ok', text: `已就绪 · ${java.vendor || ''} ${java.version || ''}（${java.arch || 'x64'}）`.trim() };
}

export async function mountRuntimePanel(root, options = {}) {
  if (!root) throw new Error('mountRuntimePanel: 缺少根节点');
  const bridge = options.bridge;
  if (!bridge) throw new Error('mountRuntimePanel: 缺少 bridge');

  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : null;
  const nodes = {
    body: qs(root, '[data-wmc-env-body]'),
    summary: qs(root, '[data-wmc-env-summary]'),
    meta: qs(root, '[data-wmc-env-meta]'),
    apply: qs(root, '[data-wmc-env-apply]'),
    reset: qs(root, '[data-wmc-env-reset]'),
  };
  for (const [name, node] of Object.entries(nodes)) {
    if (!node) throw new Error(`mountRuntimePanel: 缺少节点 ${name}`);
  }

  const cleanups = [];
  const selects = [];

  /** 面板状态（内存里的草稿，点「保存并应用」才落盘） */
  const state = {
    config: null,
    system: null,
    javaList: [],
    sources: [],
    latencies: new Map(),
    dirty: false,
    lastCheckAt: null,
  };

  /* ------------------------------------------------------------ 载入数据 */
  const [config, system, javaList, sources] = await Promise.all([
    bridge.configGet(),
    bridge.systemInfo(),
    bridge.javaList(false),
    bridge.sources(),
  ]);
  state.config = { ...config };
  state.system = { ...system };
  state.javaList = javaList || [];
  state.sources = sources || [];
  if (!state.config.maxMemoryMb) state.config.maxMemoryMb = recommendMemoryMb(state.system.totalMemMb);
  state.lastCheckAt = Date.now();

  /* ------------------------------------------------------------ 行构造 */
  function makeRow({ label, valueNode, ctlNodes = [], level = 'ok', hint = null, hintLevel }) {
    const valueCls = ['wmc-env__value'];
    if (level === 'ok') valueCls.push('is-ok');
    else if (level === 'warn') valueCls.push('is-warn');
    else if (level === 'gold') valueCls.push('is-gold');

    const statusDot = el('span', {
      class: `wmc-status wmc-status--${level === 'warn' ? 'warn' : level === 'gold' ? 'gold' : 'ok'}`,
    }, [el('span', { class: 'wmc-status__dot' })]);

    const value = el('div', { class: valueCls.join(' ') }, [statusDot, valueNode]);
    const row = el('div', { class: 'wmc-env__row' }, [
      el('div', { class: 'wmc-env__label', text: label }),
      value,
      ctlNodes.length ? el('div', { class: 'wmc-env__ctl' }, ctlNodes) : el('div'),
    ]);
    if (hint) {
      row.append(el('div', {
        class: 'wmc-env__hint' + (hintLevel === 'warn' ? ' is-warn' : ''),
        text: hint,
      }));
    }
    return row;
  }

  function group(title, rows) {
    return el('section', { class: 'wmc-env__group' }, [
      el('div', { class: 'wmc-env__groupTitle', text: title }),
      el('div', {}, rows),
    ]);
  }

  /* ------------------------------------------------------------ 各行的具体实现 */

  /** Java：下拉选择 + 重新检测 */
  function buildJavaRow() {
    const selected = state.javaList.find((j) => j.path === state.config.javaPath) || null;
    const advice = javaAdvice(selected, state.javaList);

    const items = [
      { value: '', label: '自动选择', desc: '由启动器决定' },
      ...state.javaList.map((j) => ({
        value: j.path,
        label: `${j.name} · ${j.vendor || ''}`.trim(),
        desc: j.ok === false ? '不适用' : (j.arch || ''),
      })),
    ];
    const select = new CustomSelect({
      items,
      value: state.config.javaPath || '',
      ariaLabel: 'Java 运行时',
      minWidth: '210px',
      onChange: (value) => {
        state.config.javaPath = value;
        state.dirty = true;
        render();
      },
    });
    selects.push(select);

    const refreshBtn = el('button', {
      class: 'wmc-btn wmc-btn--gold wmc-btn--sm',
      attrs: { type: 'button', title: '重新检测系统里的 Java 运行时' },
    }, [iconEl('refresh', 13), '重新检测']);
    refreshBtn.addEventListener('click', refreshJava);

    const valueText = el('span', {
      class: 'wmc-env__valueText',
      text: selected ? `${selected.name} ${selected.version} · ${selected.vendor}` : '自动选择（未指定）',
      attrs: { title: selected ? selected.path : '' },
    });

    return makeRow({
      label: 'Java 运行时',
      valueNode: valueText,
      ctlNodes: [select.element, refreshBtn],
      level: advice.level,
      hint: advice.level === 'ok' ? null : advice.text,
      hintLevel: advice.level === 'warn' ? 'warn' : undefined,
    });
  }

  async function refreshJava() {
    toastInfo('正在重新检测', '扫描注册表与常见安装目录…');
    try {
      state.javaList = await bridge.javaList(true) || [];
      state.lastCheckAt = Date.now();
      if (state.config.javaPath && !state.javaList.some((j) => j.path === state.config.javaPath)) {
        state.config.javaPath = '';
      }
      render();
      toastOk('检测完成', `共发现 ${state.javaList.length} 个 Java 运行时`);
    } catch (error) {
      toastErr('检测失败', String(error?.message || error));
    }
  }

  /** 内存：步进器 + 内存条 */
  function buildMemoryRow() {
    const total = Number(state.system.totalMemMb) || 8192;
    const free = Number(state.system.freeMemMb) || null;
    const maxMb = clamp(Number(state.config.maxMemoryMb) || recommendMemoryMb(total),
      MEM_MIN_MB, hardMaxMb(total));
    state.config.maxMemoryMb = maxMb;
    const advice = memoryAdvice(maxMb, total, free);

    const meterFill = el('div', { class: 'wmc-meter__fill' });
    const meter = el('div', { class: 'wmc-meter' }, [meterFill]);
    if (advice.level === 'warn') meter.classList.add('wmc-meter--warn');
    else if (advice.level === 'ok') meter.classList.add('wmc-meter--ok');
    meterFill.style.width = `${clamp(Math.round((maxMb / total) * 100), 0, 100)}%`;

    const meterTop = el('div', { class: 'wmc-env__meterTop' }, [
      el('b', { text: `${maxMb} MB` }),
      el('span', { text: `/ 共 ${(total / 1024).toFixed(0)} GB` }),
      free ? el('span', { text: `· 可用 ${(free / 1024).toFixed(1)} GB` }) : null,
    ]);

    const stepVal = el('span', { class: 'wmc-env__stepVal', text: `${maxMb} MB` });
    const decBtn = el('button', {
      class: 'wmc-env__stepBtn', attrs: { type: 'button', 'aria-label': '减少分配内存' }, text: '−',
    });
    const incBtn = el('button', {
      class: 'wmc-env__stepBtn', attrs: { type: 'button', 'aria-label': '增加分配内存' }, text: '＋',
    });
    const apply = (delta) => {
      const next = clamp(state.config.maxMemoryMb + delta, MEM_MIN_MB, hardMaxMb(total));
      if (next === state.config.maxMemoryMb) return;
      state.config.maxMemoryMb = next;
      state.dirty = true;
      render();
    };
    decBtn.addEventListener('click', () => apply(-MEM_STEP_MB));
    incBtn.addEventListener('click', () => apply(MEM_STEP_MB));
    decBtn.disabled = maxMb <= MEM_MIN_MB;
    incBtn.disabled = maxMb >= hardMaxMb(total);

    const meterWrap = el('div', { class: 'wmc-env__meterWrap' }, [meterTop, meter]);

    return makeRow({
      label: '物理内存',
      valueNode: meterWrap,
      ctlNodes: [el('div', { class: 'wmc-env__stepper' }, [decBtn, stepVal, incBtn])],
      level: advice.level,
      hint: advice.text,
      hintLevel: advice.level === 'warn' ? 'warn' : undefined,
    });
  }

  /** 下载源：自定义下拉 + 测速 */
  function buildSourceRow() {
    const current = state.config.downloadSource || 'auto';
    const latency = state.latencies.get(current);
    const items = state.sources.map((s) => ({
      value: s.value,
      label: s.label,
      desc: state.latencies.has(s.value) && state.latencies.get(s.value) > 0
        ? `${state.latencies.get(s.value)} ms`
        : (s.desc || ''),
    }));
    const select = new CustomSelect({
      items,
      value: current,
      ariaLabel: '下载源',
      minWidth: '200px',
      onChange: (value) => {
        state.config.downloadSource = value;
        state.dirty = true;
        render();
      },
    });
    selects.push(select);

    const testBtn = el('button', {
      class: 'wmc-btn wmc-btn--gold wmc-btn--sm',
      attrs: { type: 'button', title: '测试各下载源延迟' },
    }, [iconEl('bolt', 13), '测速']);
    testBtn.addEventListener('click', testSources);

    const label = state.sources.find((s) => s.value === current)?.label || current;
    const valueText = el('span', {
      class: 'wmc-env__valueText',
      text: latency != null ? `${label} · ${latency} ms` : label,
    });

    // 状态：测过速且延迟合理 → 绿；未测速 → 金（提示可测速）；延迟过高 → 红
    let level = 'gold';
    let hint = '尚未测速：点击「测速」可从 BMCLAPI 与官方源中挑选更快的那个';
    if (latency != null) {
      if (latency === 0) { level = 'gold'; hint = '智能选择：启动时按测速结果自动切换'; }
      else if (latency <= 800) { level = 'ok'; hint = null; }
      else { level = 'warn'; hint = `该源延迟偏高（${latency} ms），建议切换镜像`; }
    }

    return makeRow({
      label: '下载源',
      valueNode: valueText,
      ctlNodes: [select.element, testBtn],
      level,
      hint,
      hintLevel: hint && level === 'warn' ? 'warn' : undefined,
    });
  }

  async function testSources() {
    toastInfo('正在测速', '并发探测各下载源…');
    try {
      const results = await bridge.testSources() || [];
      state.latencies = new Map(results.map((r) => [r.value, r.latencyMs]));
      const fastest = results
        .filter((r) => r.latencyMs > 0)
        .sort((a, b) => a.latencyMs - b.latencyMs)[0];
      render();
      if (fastest) toastOk('测速完成', `最快：${fastest.label}（${fastest.latencyMs} ms）`);
    } catch (error) {
      toastErr('测速失败', String(error?.message || error));
    }
  }

  /** 游戏目录：路径 + 选择 + 打开 */
  function buildGameDirRow() {
    const dir = state.config.gameDir || state.system.gameDir || '';
    const writable = state.system.gameDirWritable !== false;

    const pathNode = el('span', {
      class: 'wmc-env__path',
      text: middleEllipsis(dir, 52),
      attrs: { title: dir },
    });

    const pickBtn = el('button', {
      class: 'wmc-btn wmc-btn--gold wmc-btn--sm', attrs: { type: 'button' },
    }, [iconEl('folder', 13), '选择目录']);
    pickBtn.addEventListener('click', async () => {
      try {
        const picked = await bridge.pickDirectory(dir);
        if (picked) {
          state.config.gameDir = picked;
          state.dirty = true;
          render();
          toastOk('已选择目录', middleEllipsis(picked, 60));
        }
      } catch (error) {
        toastErr('选择目录失败', String(error?.message || error));
      }
    });

    const openBtn = el('button', {
      class: 'wmc-btn wmc-btn--ghost wmc-btn--sm', attrs: { type: 'button' },
    }, [iconEl('external', 13), '打开']);
    openBtn.addEventListener('click', async () => {
      try {
        await bridge.openPath(state.config.gameDir || state.system.gameDir);
      } catch (error) {
        toastErr('打开目录失败', String(error?.message || error));
      }
    });

    return makeRow({
      label: '游戏目录',
      valueNode: pathNode,
      ctlNodes: [pickBtn, openBtn],
      level: writable ? 'ok' : 'warn',
      hint: writable ? null : '该目录不可写，建议换到非系统盘（例如 D:\\WMC\\.minecraft）',
      hintLevel: writable ? undefined : 'warn',
    });
  }

  /** 只读信息行 */
  function buildInfoRow(label, value, { mono = false, title = '' } = {}) {
    const node = mono
      ? el('span', { class: 'wmc-env__path', text: middleEllipsis(value, 52), attrs: { title: title || value } })
      : el('span', { class: 'wmc-env__valueText', text: value, attrs: { title: title || value } });
    return el('div', { class: 'wmc-env__row' }, [
      el('div', { class: 'wmc-env__label', text: label }),
      el('div', { class: 'wmc-env__value' }, [node]),
      el('div'),
    ]);
  }

  /* ------------------------------------------------------------ 渲染 */
  function render() {
    for (const select of selects.splice(0)) select.destroy();

    const sys = state.system;
    const javaRow = buildJavaRow();
    const memRow = buildMemoryRow();
    const sourceRow = buildSourceRow();
    const dirRow = buildGameDirRow();

    nodes.body.replaceChildren(
      group('运行环境', [javaRow, memRow, sourceRow, dirRow]),
      group('启动器与系统', [
        buildInfoRow('操作系统', `${sys.os || '未知'} · ${sys.cpuCount || '?'} 核`),
        buildInfoRow('启动器版本', `WMC ${sys.launcherVersion || '1.0.0'}`),
        buildInfoRow('配置文件', sys.paths?.config || sys.configPath || '（未提供）', { mono: true }),
      ]),
    );

    // 顶部汇总：正常 / 需注意
    const levels = [javaRow, memRow, sourceRow, dirRow].map((row) => {
      const value = row.querySelector('.wmc-env__value');
      if (value.classList.contains('is-warn')) return 'warn';
      if (value.classList.contains('is-gold')) return 'gold';
      return 'ok';
    });
    const warns = levels.filter((l) => l === 'warn').length;
    const golds = levels.filter((l) => l === 'gold').length;
    const allOk = warns === 0 && golds === 0;

    nodes.summary.replaceChildren(
      el('span', {
        class: `wmc-status wmc-status--${warns ? 'warn' : allOk ? 'ok' : 'gold'}`,
      }, [
        el('span', { class: 'wmc-status__dot' }),
        el('span', {
          class: 'wmc-status__text',
          text: warns ? `${warns} 项需要处理` : (allOk ? '全部正常' : `${golds} 项建议优化`),
        }),
      ]),
      el('span', { class: 'wmc-chip', text: `${javaRow ? state.javaList.length : 0} 个 Java` }),
    );

    nodes.meta.textContent = [
      state.lastCheckAt ? `检测于 ${new Date(state.lastCheckAt).toLocaleTimeString('zh-CN')}` : '',
      state.dirty ? '有未保存的修改' : '已同步',
      `数据来源：${bridge.mode === 'ipc' ? '主进程 IPC' : '内置模拟数据'}`,
    ].filter(Boolean).join(' · ');
  }

  /* ------------------------------------------------------------ 底部动作 */
  const onApply = async () => {
    nodes.apply.disabled = true;
    nodes.apply.classList.add('is-busy');
    try {
      const saved = await bridge.configPatch({
        javaPath: state.config.javaPath,
        maxMemoryMb: state.config.maxMemoryMb,
        minMemoryMb: Math.min(state.config.minMemoryMb || Math.round(state.config.maxMemoryMb / 4), state.config.maxMemoryMb),
        downloadSource: state.config.downloadSource,
        gameDir: state.config.gameDir,
      });
      if (saved && typeof saved === 'object') state.config = { ...state.config, ...saved };
      state.dirty = false;
      render();
      toastOk('已保存', '运行环境配置已写入启动器设置');
      onChanged?.(state.config);
    } catch (error) {
      toastErr('保存失败', String(error?.message || error));
    } finally {
      nodes.apply.disabled = false;
      nodes.apply.classList.remove('is-busy');
    }
  };

  const onReset = () => {
    state.config.javaPath = '';
    state.config.maxMemoryMb = recommendMemoryMb(state.system.totalMemMb);
    state.config.downloadSource = 'auto';
    state.config.gameDir = '';
    state.dirty = true;
    state.latencies.clear();
    render();
    toastInfo('已恢复推荐值', '点击「保存并应用」后生效');
  };

  // 事件统一登记到 cleanups：destroy() 时一次性解绑（放在两个回调都定义之后）
  cleanups.push(on(nodes.apply, 'click', onApply), on(nodes.reset, 'click', onReset));

  /* ------------------------------------------------------------ 启动 */
  render();

  return {
    refresh: render,
    getConfig: () => ({ ...state.config }),
    isDirty: () => state.dirty,
    destroy() {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      for (const select of selects.splice(0)) select.destroy();
      nodes.body.replaceChildren();
    },
  };
}

export { iconSvg };