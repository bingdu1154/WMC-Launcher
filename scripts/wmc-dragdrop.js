/**
 * WMC 启动器 · 全局拖拽安装 + 通用信笺弹窗
 * ---------------------------------------------------------------------------
 * 拖拽（所有页面通用，挂在 app-shell 上一次即可）：
 *   文件拖入窗口 → 全屏水墨遮罩「松开鼠标以解析并安装整合包」
 *   松手 → 取磁盘路径（Electron 32+ 走 preload 的 webUtils.getPathForFile）
 *        → 主进程 wmc:modpack:inspect 识别（CurseForge / Modrinth / PCL2 / HMCL / MultiMC / WMC）
 *        → 弹确认框 → wmc:modpack:install 解压进 versions/<隔离名>/ 并写 wmc-pack.json
 *
 * 注意：本文件不做任何文件读取或解压，只负责事件与展示；所有 IO 在主进程。
 */
import { el, iconSvg, on, qs } from './wmc-dom.js';
import { toastErr, toastInfo, toastOk } from './wmc-toast.js';

const DIALOG_ANIM_MS = 320;
const ACCEPT_EXT = ['.zip', '.mrpack'];

/* ============================================================================
   通用信笺弹窗
   ========================================================================== */

/**
 * 打开一个信笺弹窗（拖拽安装确认、版本详情都用它）。
 * @param {{title:string, buildBody:(body:HTMLElement, api:{close:()=>void})=>void,
 *          hint?:string, actions?:HTMLElement[]}} options
 * @returns {{close:()=>void, element:HTMLElement}}
 */
export function openWmcDialog(options) {
  const { title, buildBody, hint, actions } = options;

  const dialog = el('div', {
    class: 'wmc-dialog wmc-scope',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
  });

  const closeBtn = el('button', {
    class: 'wmc-dialog__close',
    attrs: { type: 'button', 'aria-label': '关闭' },
  });
  closeBtn.innerHTML = iconSvg('close', 14);

  const body = el('div', { class: 'wmc-dialog__bd' });

  const close = () => {
    offMask();
    offClose();
    document.removeEventListener('keydown', onKey);
    dialog.classList.remove('is-open');
    setTimeout(() => dialog.remove(), DIALOG_ANIM_MS);
  };

  buildBody(body, { close });

  const panel = el('div', { class: 'wmc-dialog__panel' }, [
    el('div', { class: 'wmc-dialog__hd' }, [
      el('span', { class: 'wmc-dialog__title', text: title }),
      closeBtn,
    ]),
    body,
    hint ? el('div', { class: 'wmc-dialog__hint', text: hint }) : null,
    actions?.length ? el('div', { class: 'wmc-dialog__actions' }, actions) : null,
  ]);

  dialog.append(panel);
  document.body.append(dialog);
  requestAnimationFrame(() => dialog.classList.add('is-open'));

  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const offMask = on(dialog, 'mousedown', (event) => { if (event.target === dialog) close(); });
  const offClose = on(closeBtn, 'click', close);
  closeBtn.focus?.();

  return { close, element: dialog };
}

/** 键值行（弹窗里展示版本/整合包信息） */
export function kvRow(key, value, variant = '') {
  return el('div', { class: 'wmc-kv' }, [
    el('span', { class: 'wmc-kv__key', text: key }),
    el('span', { class: `wmc-kv__val${variant}`, text: value }),
  ]);
}

/* ============================================================================
   拖拽遮罩
   ========================================================================== */

function ensureOverlay() {
  let node = qs(document.body, '.wmc-drop');
  if (node) return node;

  node = el('div', { class: 'wmc-drop wmc-scope', attrs: { 'aria-hidden': 'true' } }, [
    el('div', { class: 'wmc-drop__mask' }),
    el('div', { class: 'wmc-drop__panel' }, [
      (() => {
        const icon = el('span', { class: 'wmc-drop__icon' });
        icon.innerHTML = iconSvg('pack', 26);
        return icon;
      })(),
      el('div', { class: 'wmc-drop__title', text: '松开鼠标以解析并安装整合包' }),
      el('div', { class: 'wmc-drop__badge', text: 'CurseForge · Modrinth · PCL2 · HMCL' }),
      el('div', {
        class: 'wmc-drop__hint',
        text: '支持 .zip / .mrpack 整合包；解析与解压都在主进程完成，安装后会生成独立的版本隔离文件夹。',
      }),
    ]),
  ]);
  document.body.append(node);
  return node;
}

/**
 * 挂载全局拖拽：所有页面都会生效（只要外壳还活着）。
 * @param {{bridge:object, onInstalled?:(result:object)=>void}} options
 */
export function mountGlobalDrop({ bridge, onInstalled } = {}) {
  if (!bridge) throw new Error('mountGlobalDrop: 缺少 bridge');
  const overlay = ensureOverlay();
  let depth = 0;          // dragenter/dragleave 会成对触发，用计数避免闪烁
  let busy = false;       // 正在解析 / 安装时不再接受新的拖拽

  const show = () => { overlay.classList.add('is-active'); overlay.setAttribute('aria-hidden', 'false'); };
  const hide = () => {
    depth = 0;
    overlay.classList.remove('is-active');
    overlay.setAttribute('aria-hidden', 'true');
  };

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  const extOk = (name) => ACCEPT_EXT.some((ext) => String(name || '').toLowerCase().endsWith(ext));

  const onEnter = (event) => {
    if (!hasFiles(event) || busy) return;
    event.preventDefault();
    depth += 1;
    show();
  };

  const onOver = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();                    // 必须阻止默认行为，drop 才会触发
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!overlay.classList.contains('is-active')) show();
  };

  const onLeave = (event) => {
    if (!hasFiles(event)) return;
    depth -= 1;
    if (depth <= 0) hide();
  };

  const onDrop = async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    hide();
    if (busy) return;

    const files = Array.from(event.dataTransfer?.files || []);
    const pack = files.find((f) => extOk(f.name)) || files[0];
    if (!pack) {
      toastErr('无法识别', '拖拽内容里没有文件');
      return;
    }
    if (!extOk(pack.name)) {
      toastErr('仅支持整合包', `${pack.name}：请拖入 .zip 或 .mrpack 文件`);
      return;
    }

    // Electron 32+ 必须走 preload 的 webUtils.getPathForFile
    const filePath = bridge.filePathOf(pack);
    busy = true;
    try {
      if (!filePath) {
        // 浏览器预览 / preload 未暴露：明确说明，不假装成功
        openWmcDialog({
          title: '需要 Electron 主进程',
          hint: '拖拽安装必须在 Electron 里运行：渲染层拿到的是 File 对象，磁盘路径由 preload 的 webUtils.getPathForFile 提供，解压在主进程完成。',
          buildBody(body) {
            body.append(kvRow('文件名', pack.name));
            body.append(kvRow('体积', `${(pack.size / 1048576).toFixed(1)} MB`));
            body.append(kvRow('状态', '未取到磁盘路径（当前不在 Electron 环境）', ' wmc-kv__val--warn'));
          },
        });
        return;
      }

      toastInfo('正在解析整合包', pack.name);
      const report = await bridge.modpackInspect(filePath);
      showInspectDialog(report, { bridge, onInstalled, filePath });
    } catch (error) {
      toastErr('解析失败', String(error?.message || error));
    } finally {
      busy = false;
    }
  };

  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragover', onOver);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('drop', onDrop);

  return {
    destroy() {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      hide();
    },
    /** 菜单里的兜底入口：弹系统文件框挑整合包 */
    async openPicker() {
      try {
        const picked = await bridge.modpackPick();
        if (!picked) return;
        showInspectDialog(picked.report, { bridge, onInstalled, filePath: picked.filePath });
      } catch (error) {
        toastErr('打开失败', String(error?.message || error));
      }
    },
  };
}

/* ============================================================================
   识别结果 → 确认 / 安装
   ========================================================================== */

const KIND_HINT = {
  curseforge: 'CurseForge 整合包：包内 manifest.json 只记录了模组 ID，安装 Modrinth 风格的文件后还需按 ID 补齐模组。',
  modrinth: 'Modrinth 整合包（.mrpack）：index.json 里带完整下载地址，可直接按清单补齐模组。',
  pcl2: 'PCL2 导出的整合包：按 PCL 的目录约定解压到版本隔离目录。',
  hmcl: 'HMCL / mcbbs 格式整合包：解压后由启动器按相同的目录规则识别。',
  multimc: 'MultiMC / Prism 实例包：已识别 instance.cfg 与 mmc-pack.json。',
  wmc: 'WMC 自己导出的实例包，可直接还原。',
  unknown: '未能识别出整合包特征文件，无法自动安装。',
};

function showInspectDialog(report, { bridge, onInstalled, filePath }) {
  const meta = report.meta || {};
  const tags = el('div', { class: 'wmc-dialog__tags' }, [
    el('span', { class: `wmc-pill${report.ok ? '' : ' wmc-pill--warn'}`, text: report.label }),
    meta.mcVersion ? el('span', { class: 'wmc-pill', text: meta.mcVersion }) : null,
    meta.loaderKind ? el('span', { class: 'wmc-pill wmc-pill--muted', text: meta.loaderKind }) : null,
    report.hasOverrides ? el('span', { class: 'wmc-pill wmc-pill--muted', text: '含 overrides' }) : null,
  ].filter(Boolean));

  const installBtn = el('button', {
    class: 'wmc-primaryBtn',
    attrs: { type: 'button' },
    text: report.ok ? '确认安装' : '无法安装',
  });
  if (!report.ok) installBtn.disabled = true;

  let dialog;
  const closeBtn = el('button', {
    class: 'wmc-ghostBtn wmc-ghostBtn--sm',
    attrs: { type: 'button' },
    text: '取消',
  });
  on(closeBtn, 'click', () => dialog?.close());

  dialog = openWmcDialog({
    title: report.ok ? '识别到整合包' : '无法识别这个压缩包',
    hint: KIND_HINT[report.kind] || KIND_HINT.unknown,
    actions: [installBtn, closeBtn],
    buildBody(body) {
      body.append(tags);
      body.append(kvRow('文件名', report.file?.name || filePath));
      body.append(kvRow('特征文件', report.evidence || '未找到 manifest.json / modrinth.index.json 等'));
      if (meta.name) body.append(kvRow('整合包名', meta.name));
      if (meta.version) body.append(kvRow('包版本', String(meta.version)));
      if (meta.mcVersion) body.append(kvRow('游戏版本', String(meta.mcVersion)));
      if (meta.loader) body.append(kvRow('加载器', String(meta.loader)));
      if (meta.fileCount) body.append(kvRow('清单模组数', `${meta.fileCount} 个`));
      body.append(kvRow('压缩包内文件', `${report.file?.entryCount ?? 0} 个${report.file?.zip64 ? '（Zip64）' : ''}`));
      body.append(kvRow('体积', `${((report.file?.sizeBytes || 0) / 1048576).toFixed(1)} MB`));
      if (report.error) body.append(kvRow('解析告警', report.error, ' wmc-kv__val--warn'));
      if (!report.hasOverrides) {
        body.append(kvRow('提示', '包内没有 overrides 目录，通常表示这是一个「只含清单」的轻量包', ' wmc-kv__val--warn'));
      }
    },
  });

  on(installBtn, 'click', async () => {
    installBtn.disabled = true;
    installBtn.textContent = '正在解压…';
    try {
      const result = await bridge.modpackInstall({ filePath, name: meta.name });
      dialog.close();
      onInstalled?.(result);
      openWmcDialog({
        title: '安装完成',
        hint: '已写入 wmc-pack.json 标记；「实例管理」页可以直接读到这个包的身份信息。',
        buildBody(body) {
          body.append(kvRow('隔离文件夹', result.isolation, ' wmc-kv__val--ok'));
          body.append(kvRow('安装位置', result.targetDir, ' wmc-kv__val--mono'));
          body.append(kvRow('解压文件', `${result.extracted} 个`));
          body.append(kvRow('跳过', `${result.skipped?.length || 0} 个`));
          if (result.skipped?.length) {
            body.append(kvRow('跳过明细', result.skipped.slice(0, 3).map((s) => `${s.name}（${s.reason}）`).join('；'), ' wmc-kv__val--warn'));
          }
        },
      });
      toastOk('整合包安装完成', result.isolation);
    } catch (error) {
      installBtn.disabled = false;
      installBtn.textContent = '确认安装';
      toastErr('安装失败', String(error?.message || error));
    }
  });
}

export { showInspectDialog };