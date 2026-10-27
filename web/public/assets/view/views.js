// The page's views. Each is a function of the store's state, rendered with Preact. Rows, menus
// and dialogs are keyed by stable identity, so a state change updates the DOM nodes that show it
// and never replaces them. Focus, open menus, text selections and running CSS animations survive
// every update without any code that protects them.
import { html, Component, createRef } from './html.js';

/* ---------- tree ---------- */

// Row geometry: the phone layout has taller rows and deeper indents.
export function rowGeometry(phone) {
  return phone ? { row: 40, step: 20, base: 18 } : { row: 22, step: 16, base: 14 };
}

function cx(geo, depth) {
  return geo.base + depth * geo.step;
}

function groupId(key) {
  return 'g-' + key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function Guides({ geo, depth, guides }) {
  if (!guides) return null;
  const mid = Math.floor(geo.row / 2);
  const out = [];
  guides.continuations.forEach((on, i) => {
    if (on) out.push({ left: cx(geo, i) + 'px', top: '0', bottom: '0', width: '1px' });
  });
  if (depth > 0) {
    const parentX = cx(geo, depth - 1) + 'px';
    out.push({ left: parentX, top: '0', height: (guides.last ? mid + 1 : geo.row) + 'px', width: '1px' });
    out.push({ left: parentX, top: mid + 'px', height: '1px', width: (geo.step - 8) + 'px' });
  }
  if (guides.stem) out.push({ left: cx(geo, depth) + 'px', top: mid + 'px', bottom: '0', width: '1px' });
  return out.map((style) => html`<span class="guide" style=${style}></span>`);
}

function Chevron({ className }) {
  return html`<svg class=${className} viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"></path></svg>`;
}

function dragClass(drag, key) {
  if (!drag) return '';
  let cls = drag.source === key ? ' dz-src' : '';
  if (drag.target === key) cls += drag.mode === 'into' ? ' dz-into' : (drag.mode === 'before' ? ' dz-before' : ' dz-after');
  return cls;
}

function SessionRow({ item, ctx }) {
  const cls = 'row ' + item.kind + (item.selected ? ' selected' : '') + dragClass(ctx.drag, item.key);
  return html`<a class=${cls} role="treeitem" tabindex="0" href=${item.pending ? null : item.href} data-pending=${item.pending ? "true" : null} draggable=${false}
      aria-level=${item.level} aria-setsize=${item.setsize} aria-posinset=${item.posinset}
      aria-label=${item.ariaLabel} aria-current=${item.selected ? 'page' : null}
      data-kind=${item.kind} data-name=${item.name} data-id=${item.id} data-key=${item.key}
      data-drag=${item.kind === 'recent' ? null : (ctx.canMutate ? '1' : '0')}
      style=${{ paddingLeft: (cx(ctx.geo, item.depth) - 8) + 'px' }}>
    <${Guides} geo=${ctx.geo} depth=${item.depth} guides=${item.guides} />
    <span class="slot"><span class=${'dot st-' + item.state} title=${item.stateText}></span></span>
    <span class="name" title=${item.title}>${item.label}</span>
    ${item.create ? html`<button class="act wide" type="button" disabled=${!ctx.canMutate}
        aria-label=${'Create session ' + item.name} data-act="create">Create</button>` : null}
    ${item.pending ? html`<span class="creation-state" title=${item.error || item.stateText}>${item.error ? 'Failed: ' + item.error : item.stateText}</span>` : null}
    ${item.retry ? html`<button class="act wide" type="button" disabled=${!ctx.canMutate} data-act="retry">Retry</button>` : null}
    <span class="age" title=${item.ageTitle}>${item.age}</span>
    <button class="act" type="button" aria-label=${'Actions for ' + item.label} data-act="menu">…</button>
  </a>`;
}

function Group({ item, ctx }) {
  if (!item.open || !item.children.length) return null;
  return html`<div class=${"tree-group" + (item.extra === "recent-limit" ? " recent-scroll" : "")} style=${item.extra === "recent-limit" ? { maxHeight: (ctx.geo.row * ctx.recentLimit) + "px" } : null} role="group" id=${groupId(item.key)} aria-label=${item.label}>
    ${item.children.map((child) => html`<${TreeNode} key=${child.key} item=${child} ctx=${ctx} />`)}
  </div>`;
}

function owns(item) {
  return item.open && item.children.length ? groupId(item.key) : null;
}

function FolderRow({ item, ctx }) {
  const cls = 'row folder' + (item.open ? ' open' : '') + dragClass(ctx.drag, item.key);
  const sessions = item.count + (item.count === 1 ? ' session' : ' sessions');
  return html`<div class=${cls} role="treeitem" tabindex="0" aria-level=${item.level}
      aria-setsize=${item.setsize} aria-posinset=${item.posinset} aria-expanded=${item.open ? 'true' : 'false'}
      aria-owns=${owns(item)} aria-label=${item.ariaLabel + ', ' + sessions}
      data-kind="folder" data-id=${item.id} data-key=${item.key} data-drag=${ctx.canMutate ? '1' : '0'}
      style=${{ paddingLeft: (cx(ctx.geo, item.depth) - 8) + 'px' }}>
    <${Guides} geo=${ctx.geo} depth=${item.depth} guides=${item.guides} />
    <span class="slot"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4v8.5h13v-7H7.5L6 4z"></path></svg></span>
    <span class="name" title=${item.name}>${item.name}</span>
    <span class="count" title="Sessions inside">${String(item.count)}</span>
    <${Chevron} className="folder-chevron" />
    <button class="act" type="button" aria-label=${'Actions for ' + item.name} data-act="menu">…</button>
  </div>`;
}

const LIMITS = [[3, '3'], [5, '5'], [10, '10'], [15, '15'], [0, 'Off']];

function RecentLimit({ ctx }) {
  return html`<span class="recent-controls"><span>Rows</span>
    <select class="recent-limit" aria-label="Recent sessions count" value=${String(ctx.recentLimit)}
        onClick=${(ev) => ev.stopPropagation()} onChange=${(ev) => ctx.onRecentLimit(Number(ev.currentTarget.value), ev.currentTarget)}>
      ${LIMITS.map(([value, label]) => html`<option key=${value} value=${String(value)}>${label}</option>`)}
    </select></span>`;
}

function RecentSearch({ item, ctx }) {
  const input = createRef();
  const clear = () => { const el = input.current; ctx.onRecentQuery(''); el.focus(); };
  return html`<span class="recent-search-box" onClick=${(ev) => ev.stopPropagation()}
      onKeyDown=${(ev) => ev.stopPropagation()}>
    <input ref=${input} type="text" class="recent-search" placeholder="Search" aria-label="Search recent sessions"
      value=${ctx.recentQuery} onInput=${(ev) => ctx.onRecentQuery(ev.currentTarget.value)}
      onKeyDown=${(ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); clear(); }
        else if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          const first = item.children.find((child) => child.kind === 'recent');
          if (first) ctx.onOpenSession(first.name);
        }
      }} />
    ${ctx.recentQuery ? html`<button type="button" class="recent-search-clear" aria-label="Clear search"
      onClick=${clear}>×</button>` : null}
  </span>`;
}

function SectionRow({ item, ctx }) {
  return html`<div class=${'row section' + (item.open ? ' open' : '')} role="treeitem" tabindex="0"
      aria-level="1" aria-setsize=${item.setsize} aria-posinset=${item.posinset}
      aria-expanded=${item.open ? 'true' : 'false'} aria-owns=${owns(item)} aria-label=${item.ariaLabel}
      data-kind="section" data-id=${item.id} data-key=${item.key}>
    <span class="section-main"><${Chevron} className="section-chevron" /><span class="name">${item.label}</span></span>
    ${item.extra === 'recent-limit' ? html`<${RecentSearch} item=${item} ctx=${ctx} /><${RecentLimit} ctx=${ctx} />` : null}
  </div>`;
}

// A row and, when it is open, the group of its children. The wrapper has no role, so the
// accessibility tree sees the row with its group through aria-owns.
function TreeNode({ item, ctx }) {
  if (item.kind === 'section' || item.kind === 'folder') {
    const Row = item.kind === 'section' ? SectionRow : FolderRow;
    return html`<div class="tree-node" role="none"><${Row} item=${item} ctx=${ctx} /><${Group} item=${item} ctx=${ctx} /></div>`;
  }
  if (item.kind === 'recent-empty') return html`<div class="row recent-empty" role="status">${item.label}</div>`;
  return html`<${SessionRow} item=${item} ctx=${ctx} />`;
}

export function TreeView({ model, ctx }) {
  return model.sections.map((item) => html`<${TreeNode} key=${item.key} item=${item} ctx=${ctx} />`);
}

/* ---------- terminal header and notice ---------- */

export function TermTitle({ name, state, stateText }) {
  if (!name) return null;
  return html`<span class="slot"><span class=${'dot st-' + state} title=${stateText}></span></span><span class="term-name" title=${name}>${name}</span>`;
}

export function NoticeView({ notice, onHome }) {
  if (!notice) return 'No session open.';
  const home = html`<a class="notice-link" href="/" onClick=${onHome}>Back to sessions</a>`;
  let content;
  if (notice.kind === 'opening') content = html`<strong>Opening ${notice.name}.</strong>`;
  else if (notice.kind === 'missing') content = html`<strong>There is no session named ${notice.name}.</strong><span>It may have been deleted or renamed.</span>${home}`;
  else if (notice.kind === 'badname') content = html`<strong>${notice.name} is not a session name.</strong><span>Session names use letters, numbers, dot, dash and underscore, up to 64 characters.</span>${home}`;
  else if (notice.kind === 'error') content = html`<strong>Cannot open session ${notice.name}.</strong><span>${notice.detail}</span>${home}`;
  else content = html`<strong>This address does not name a session.</strong>${home}`;
  return html`<div class="notice" data-kind=${notice.kind}>${content}</div>`;
}

/* ---------- menu ---------- */

class MenuView extends Component {
  constructor(props) {
    super(props);
    this.state = { left: 8, top: 8 };
    this.ref = createRef();
    this.onOutside = (ev) => { if (this.ref.current && !this.ref.current.contains(ev.target)) this.props.onClose(false); };
    this.onResize = () => this.props.onClose(false);
  }

  componentDidMount() {
    const { anchor } = this.props.menu;
    const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : { right: 8, bottom: 8, top: 8 };
    const el = this.ref.current;
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    left = Math.max(8, left);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    this.setState({ left, top });
    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('resize', this.onResize);
    const first = el.querySelector('.menu-item:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  componentWillUnmount() {
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('resize', this.onResize);
  }

  onKey(ev) {
    const enabled = Array.from(this.ref.current.querySelectorAll('.menu-item:not([disabled])'));
    const at = enabled.indexOf(document.activeElement);
    let next = -1;
    if (ev.key === 'ArrowDown') next = (at + 1) % enabled.length;
    else if (ev.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = enabled.length - 1;
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.props.onClose(true); return; }
    else return;
    ev.preventDefault();
    if (enabled[next]) enabled[next].focus();
  }

  render({ menu, onClose }, { left, top }) {
    return html`<div class="menu" role="menu" aria-label=${menu.head || 'Actions'} ref=${this.ref}
        style=${{ left: left + 'px', top: top + 'px' }}
        onKeyDown=${(ev) => this.onKey(ev)}>
      ${menu.head ? html`<div class="menu-head">${menu.head}</div>` : null}
      ${menu.items.filter(Boolean).map((item, index) => html`<button key=${index}
          class=${'menu-item' + (item.danger ? ' danger' : '')} type="button" role="menuitem"
          disabled=${item.disabled === true} onClick=${() => { onClose(true); item.run(); }}>${item.label}</button>`)}
    </div>`;
  }
}

export function MenuLayer({ menu, onClose }) {
  if (!menu) return null;
  return html`<${MenuView} key=${menu.id} menu=${menu} onClose=${onClose} />`;
}

/* ---------- dialogs ---------- */

// The tree rows after the one that holds el, then the rows before it, nearest first, by key.
function rowsAround(el) {
  const row = el?.closest?.('[role="tree"] .row[data-key]');
  if (!row) return [];
  const rows = Array.from(row.closest('[role="tree"]').querySelectorAll('.row[data-key]'));
  const at = rows.indexOf(row);
  return rows.slice(at + 1).concat(rows.slice(0, at).reverse()).map((item) => item.dataset.key);
}

// Where focus goes when a dialog closes: the control that opened it, or when a delete took that
// control's row away, the row that took its place, else the nearest row above.
function returnFocus(opener, around) {
  if (opener?.isConnected) { opener.focus(); return; }
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const tree = document.querySelector('[role="tree"]');
  for (const key of around) {
    const row = tree?.querySelector(`.row[data-key="${CSS.escape(key)}"]`);
    if (row) { row.focus(); return; }
  }
}

// One dialog. spec: { title, initial, body(values, set), submitLabel, onSubmit(values), extra,
// cancel, cancelLabel }. Its fields are the component's own state. Closing it puts focus back
// where it was when the dialog opened.
class DialogView extends Component {
  constructor(props) {
    super(props);
    this.state = { values: { ...(props.spec.initial || {}) }, busy: false, error: '' };
    this.set = (patch) => this.setState((s) => ({ values: { ...s.values, ...patch } }));
    this.opener = document.activeElement;
    this.around = rowsAround(this.opener);
    this.ref = createRef();
  }

  componentDidMount() {
    const card = this.ref.current.querySelector('.modal-card');
    const focusEl = card.querySelector('[data-autofocus]')
      || card.querySelector('input:not([type=radio]), select, textarea')
      || card.querySelector('.modal-foot .primary');
    if (!focusEl) return;
    focusEl.focus();
    if (focusEl.select && focusEl.type === 'text') focusEl.select();
  }

  componentWillUnmount() {
    const { opener, around } = this;
    if (!opener?.focus || this.ref.current?.contains(opener)) return;
    // The next dialog down, if any, is still inert until this one is gone.
    setTimeout(() => returnFocus(opener, around), 0);
  }

  run(fn) {
    return async () => {
      this.setState({ error: '', busy: true });
      try {
        await fn(this.state.values);
        this.props.onClose();
      } catch (e) {
        this.setState({ error: this.props.errText(e), busy: false });
      }
    };
  }

  render({ spec, top, onClose }, { values, busy, error }) {
    return html`<div class="modal-back" inert=${!top} ref=${this.ref}
        onPointerDown=${(ev) => { if (ev.target === ev.currentTarget && !busy) onClose(); }}>
      <form class=${'modal-card' + (busy ? ' busy' : '')} role="dialog" aria-modal="true" aria-label=${spec.title}
          onSubmit=${(ev) => { ev.preventDefault(); if (spec.onSubmit && !busy) this.run(spec.onSubmit)(); }}>
        <h2 class="modal-title">${spec.title}</h2>
        <div class="modal-body">${spec.body(values, this.set)}</div>
        <p class="form-error" role="alert" hidden=${!error}>${error}</p>
        <div class="modal-foot">
          ${spec.cancel === false ? null : html`<button class="btn" type="button" disabled=${busy} onClick=${onClose}>${spec.cancelLabel || 'Cancel'}</button>`}
          ${(spec.extra || []).filter(Boolean).map((action, index) => html`<button key=${index}
              class=${'btn' + (action.danger ? ' danger' : '')} type="button" disabled=${busy}
              onClick=${this.run(action.run)}>${action.label}</button>`)}
          ${spec.onSubmit ? html`<button class="btn primary" type="submit" disabled=${busy}>${spec.submitLabel || 'Save'}</button>` : null}
        </div>
      </form>
    </div>`;
  }
}

export function ModalLayer({ modals, onClose, errText }) {
  return modals.map((modal, index) => html`<${DialogView} key=${modal.id} spec=${modal.spec}
      top=${index === modals.length - 1} onClose=${() => onClose(modal.id)} errText=${errText} />`);
}
