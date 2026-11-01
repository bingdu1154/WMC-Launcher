/**
 * WMC 面板 · 自定义下拉组件（绝不使用系统原生 <select>）
 * ---------------------------------------------------------------------------
 * 特性：
 *   - 宣纸白背景 + 极细金边 + 微圆角 + 平滑展开动画（见 primitives.css）
 *   - 完整键盘操作：Enter/Space 展开、↑↓ 移动、Enter 选中、Esc 关闭、
 *     Home/End、首字母跳跃（type-ahead）
 *   - ARIA：combobox / listbox / option + aria-activedescendant
 *   - 浮层挂到 body 并用 fixed 定位，避免被父级 overflow 裁切
 *   - 视口空间不足时自动向上弹出
 */
import { el, iconSvg } from './wmc-dom.js';

let uidSeq = 0;
const nextId = (prefix) => `${prefix}-${(uidSeq += 1)}`;

export class CustomSelect {
  /**
   * @param {object} opts
   * @param {Array<{value:string,label:string,desc?:string,group?:string,disabled?:boolean}>} opts.items
   * @param {string} [opts.value]
   * @param {string} [opts.placeholder]
   * @param {string} [opts.ariaLabel]
   * @param {boolean} [opts.disabled]
   * @param {string} [opts.minWidth] 例如 '180px'
   * @param {(value:string, item:object) => void} [opts.onChange]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.items = Array.isArray(opts.items) ? opts.items.slice() : [];
    this.value = opts.value;
    this.disabled = !!opts.disabled;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    this.open = false;
    this.activeIndex = -1;
    this.typeBuffer = '';
    this.typeAt = 0;
    this.cleanups = [];

    this.listId = nextId('wmc-listbox');
    this.triggerId = nextId('wmc-combobox');

    this.valueEl = el('span', { class: 'wmc-select__value' });
    this.caretEl = el('span', { class: 'wmc-select__caret', attrs: { 'aria-hidden': 'true' } });

    this.trigger = el('button', {
      class: 'wmc-select__trigger',
      attrs: {
        type: 'button',
        id: this.triggerId,
        role: 'combobox',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        'aria-controls': this.listId,
        'aria-label': opts.ariaLabel || '',
      },
      on: {
        click: (e) => { e.preventDefault(); this.toggle(); },
        keydown: (e) => this.onTriggerKeydown(e),
      },
    }, [this.valueEl, this.caretEl]);

    this.panel = el('div', {
      class: 'wmc-scope wmc-select__panel',
      attrs: { id: this.listId, role: 'listbox', tabindex: '-1' },
      on: {
        // 用 pointerdown 保证在 blur 之前响应
        pointerdown: (e) => e.preventDefault(),
        click: (e) => this.onPanelClick(e),
      },
    });

    this.root = el('div', { class: 'wmc-select' }, [this.trigger]);
    if (opts.minWidth) this.root.style.minWidth = opts.minWidth;
    if (this.disabled) this.root.classList.add('is-disabled');

    this.renderOptions();
    this.syncValueLabel();
  }

  /** 组件根节点（插入到面板里的是它，浮层由组件自己管理） */
  get element() {
    return this.root;
  }

  // ------------------------------------------------------------------ 数据

  setItems(items, value = undefined) {
    this.items = Array.isArray(items) ? items.slice() : [];
    if (value !== undefined) this.value = value;
    this.renderOptions();
    this.syncValueLabel();
  }

  setValue(value, { silent = false } = {}) {
    this.value = value;
    this.syncValueLabel();
    this.markSelected();
    if (!silent) this.emit();
  }

  getValue() {
    return this.value;
  }

  getItem() {
    return this.items.find((it) => it.value === this.value) || null;
  }

  setDisabled(disabled) {
    this.disabled = !!disabled;
    this.trigger.disabled = this.disabled;
    this.root.classList.toggle('is-disabled', this.disabled);
    if (this.disabled) this.close();
  }

  /** 解绑一切监听，便于页面卸载（避免 Electron 里反复切换页面造成泄漏） */
  destroy() {
    this.close();
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.root.remove();
  }

  // ------------------------------------------------------------------ 渲染

  renderOptions() {
    const nodes = [];
    let lastGroup = null;
    this.items.forEach((item, index) => {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        nodes.push(el('div', { class: 'wmc-select__group', text: item.group }));
      }
      const isSelected = item.value === this.value;
      const opt = el('div', {
        class: ['wmc-select__opt', isSelected ? 'is-selected' : '', item.disabled ? 'is-disabled' : '']
          .filter(Boolean).join(' '),
        dataset: { index: String(index), value: item.value },
        attrs: {
          id: `${this.listId}-opt-${index}`,
          role: 'option',
          'aria-selected': isSelected ? 'true' : 'false',
          'aria-disabled': item.disabled ? 'true' : 'false',
        },
      }, [
        el('span', { text: item.label }),
        item.desc ? el('span', { class: 'wmc-select__optDesc', text: item.desc }) : null,
      ]);
      nodes.push(opt);
    });
    this.panel.replaceChildren(...nodes);
    return this.panel;
  }

  markSelected() {
    for (const opt of this.panel.querySelectorAll('.wmc-select__opt')) {
      const selected = opt.dataset.value === this.value;
      opt.classList.toggle('is-selected', selected);
      opt.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  syncValueLabel() {
    const item = this.getItem();
    const text = item ? item.label : (this.opts.placeholder || '请选择');
    this.valueEl.textContent = text;
    this.valueEl.classList.toggle('is-placeholder', !item);
    this.trigger.setAttribute('aria-label',
      `${this.opts.ariaLabel || '下拉选择'}：${text}`);
  }

  // ------------------------------------------------------------------ 展开/收起

  toggle() {
    if (this.disabled) return;
    if (this.open) this.close();
    else this.openPanel();
  }

  openPanel() {
    if (this.open || this.disabled) return;
    this.open = true;

    // 挂到 body：脱离父级 overflow:auto 的裁切
    document.body.append(this.panel);
    this.panel.classList.add('is-open');
    this.root.classList.add('is-open');
    this.trigger.setAttribute('aria-expanded', 'true');

    this.activeIndex = Math.max(0, this.items.findIndex((it) => it.value === this.value));
    this.highlight(this.activeIndex, { scroll: true });
    this.position();

    // 关闭时机：点击外部 / Esc / 滚动 / 窗口尺寸变化
    const onDocPointer = (e) => {
      if (!this.root.contains(e.target) && !this.panel.contains(e.target)) this.close();
    };
    const onScroll = () => this.position();
    const onResize = () => this.close();

    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    this.cleanups.push(
      () => document.removeEventListener('pointerdown', onDocPointer, true),
      () => window.removeEventListener('scroll', onScroll, true),
      () => window.removeEventListener('resize', onResize),
    );
  }

  close({ focus = false } = {}) {
    if (!this.open) return;
    this.open = false;
    this.panel.classList.remove('is-open');
    this.root.classList.remove('is-open');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.removeAttribute('aria-activedescendant');
    // 动画结束后再移出文档，保证收起有过渡
    const panel = this.panel;
    setTimeout(() => { if (!this.open && panel.parentNode === document.body) panel.remove(); }, 200);
    this.cleanups.splice(0).forEach((fn) => fn());
    if (focus) this.trigger.focus();
  }

  /** 计算浮层位置（空间不足自动向上） */
  position() {
    const rect = this.trigger.getBoundingClientRect();
    const gap = 6;
    const panelHeight = Math.min(this.panel.scrollHeight || 260, 288);
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const dropUp = spaceBelow < panelHeight && rect.top > spaceBelow;

    this.panel.style.position = 'fixed';
    this.panel.style.left = `${Math.round(rect.left)}px`;
    this.panel.style.minWidth = `${Math.round(rect.width)}px`;
    this.panel.style.maxHeight = `${Math.min(288, dropUp ? rect.top - gap - 8 : spaceBelow - 8)}px`;
    if (dropUp) {
      this.panel.style.top = 'auto';
      this.panel.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
      this.panel.style.transformOrigin = 'bottom center';
    } else {
      this.panel.style.bottom = 'auto';
      this.panel.style.top = `${Math.round(rect.bottom + gap)}px`;
      this.panel.style.transformOrigin = 'top center';
    }
  }

  // ------------------------------------------------------------------ 选择

  selectIndex(index, { silent = false } = {}) {
    const item = this.items[index];
    if (!item || item.disabled) return;
    this.value = item.value;
    this.syncValueLabel();
    this.markSelected();
    this.close({ focus: true });
    if (!silent) this.emit();
  }

  emit() {
    if (this.onChange) this.onChange(this.value, this.getItem());
  }

  onPanelClick(event) {
    const opt = event.target.closest?.('.wmc-select__opt');
    if (!opt || opt.classList.contains('is-disabled')) return;
    const index = Number(opt.dataset.index);
    this.selectIndex(Number.isFinite(index) ? index : -1);
  }

  /** 高亮某一项（键盘导航用） */
  highlight(index, { scroll = false } = {}) {
    if (!this.items.length) return;
    const bounded = (index + this.items.length) % this.items.length;
    this.activeIndex = bounded;
    const opts = this.panel.querySelectorAll('.wmc-select__opt');
    opts.forEach((opt) => opt.classList.toggle('is-active', Number(opt.dataset.index) === bounded));
    const active = this.panel.querySelector('.wmc-select__opt.is-active');
    if (active) {
      this.trigger.setAttribute('aria-activedescendant', active.id);
      if (scroll) active.scrollIntoView({ block: 'nearest' });
    }
  }

  // ------------------------------------------------------------------ 键盘

  onTriggerKeydown(event) {
    if (this.disabled) return;
    const { key } = event;

    if (!this.open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        this.openPanel();
      }
      return;
    }

    switch (key) {
      case 'Escape':
        event.preventDefault();
        this.close({ focus: true });
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.highlight(this.activeIndex + 1, { scroll: true });
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.highlight(this.activeIndex - 1, { scroll: true });
        break;
      case 'Home':
        event.preventDefault();
        this.highlight(0, { scroll: true });
        break;
      case 'End':
        event.preventDefault();
        this.highlight(this.items.length - 1, { scroll: true });
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.selectIndex(this.activeIndex);
        break;
      case 'Tab':
        this.close();
        break;
      default:
        // 首字母跳跃
        if (key.length === 1 && /\S/.test(key)) {
          const now = Date.now();
          this.typeBuffer = now - this.typeAt > 700 ? key : this.typeBuffer + key;
          this.typeAt = now;
          const lower = this.typeBuffer.toLowerCase();
          const start = this.activeIndex + 1;
          for (let i = 0; i < this.items.length; i += 1) {
            const idx = (start + i) % this.items.length;
            const item = this.items[idx];
            if (!item.disabled && String(item.label).toLowerCase().startsWith(lower)) {
              this.highlight(idx, { scroll: true });
              break;
            }
          }
        }
        break;
    }
  }
}

/** 便捷工厂 */
export function createSelect(opts) {
  return new CustomSelect(opts);
}

export { iconSvg };