// Plan usage meters in the terminal header. The agent sends one snapshot with a meter per
// window: percent used, reset time, and whether the value is stale or unavailable. Each meter
// is a small bar with its percent. Hover shows its reset time, and a click or tap opens a panel
// that lists every window with its reset time.
import { html } from './html.js';

const DAY = 24 * 60 * 60 * 1000;

export function meterPercent(meter) {
  if (!meter || !meter.available || typeof meter.percent !== 'number' || !isFinite(meter.percent)) return null;
  return Math.max(0, Math.min(100, meter.percent));
}

export function meterLevel(meter) {
  const percent = meterPercent(meter);
  if (percent === null) return 'na';
  if (percent >= 90) return 'bad';
  if (percent >= 75) return 'warn';
  return 'ok';
}

export function percentText(meter) {
  const percent = meterPercent(meter);
  return percent === null ? '–' : Math.round(percent) + '%';
}

function untilText(ms, now) {
  const minutes = Math.max(0, Math.round((ms - now) / 60000));
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + 'h ' + (minutes % 60) + 'm';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}

// "resets Thu 09:59, in 6d 13h". Within a day the weekday is left out.
export function resetText(meter, now = Date.now()) {
  const at = Number(meter?.resetsAt);
  if (meterPercent(meter) === null) return '';
  if (!isFinite(at) || at <= 0) return 'reset time unknown';
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = at - now < DAY ? '' : when.toLocaleDateString([], { weekday: 'short' }) + ' ';
  return 'resets ' + day + time + ', in ' + untilText(at, now);
}

export function meterDetail(meter, now = Date.now()) {
  if (meterPercent(meter) === null) return 'unavailable' + (meter?.error ? ': ' + meter.error : '');
  const parts = [percentText(meter) + ' used', resetText(meter, now)];
  if (meter.stale) parts.push('stale, the last refresh failed' + (meter.error ? ': ' + meter.error : ''));
  return parts.join(', ');
}

export function meterTooltip(meter, now = Date.now()) {
  return (meter?.title || meter?.label || '') + ': ' + meterDetail(meter, now);
}

export function usageSummary(usage) {
  const meters = usage && Array.isArray(usage.meters) ? usage.meters : [];
  return 'Plan usage: ' + meters.map((meter) => meter.label + ' ' + (meterPercent(meter) === null ? 'unavailable' : percentText(meter))).join(', ');
}

function Meter({ meter, now }) {
  const percent = meterPercent(meter);
  const cls = 'meter ' + meterLevel(meter) + (meter.stale ? ' stale' : '');
  return html`<span class=${cls} data-key=${meter.key} title=${meterTooltip(meter, now)}>
    <span class="meter-label">${meter.label}</span>
    <span class="meter-bar" aria-hidden="true"><span class="meter-fill" style=${'width:' + (percent === null ? 0 : percent) + '%'}></span></span>
    <span class="meter-pct">${percentText(meter)}</span>
  </span>`;
}

export function UsageMeters({ usage, now, open, onToggle }) {
  const meters = usage && Array.isArray(usage.meters) ? usage.meters : [];
  if (!meters.length) return null;
  const updated = Number(usage.updatedAt);
  return html`<button id="usage-button" class="usage" type="button" aria-haspopup="dialog" aria-expanded=${open ? 'true' : 'false'}
      aria-controls="usage-panel" aria-label=${usageSummary(usage)} onClick=${onToggle}>
    ${meters.map((meter) => html`<${Meter} key=${meter.key} meter=${meter} now=${now} />`)}
  </button>
  ${open ? html`<div id="usage-panel" class="usage-panel" role="dialog" aria-label="Plan usage">
    ${meters.map((meter) => html`<div key=${meter.key} class=${'usage-row ' + meterLevel(meter) + (meter.stale ? ' stale' : '')} data-key=${meter.key}>
      <span class="usage-row-title">${meter.title}</span>
      <span class="usage-row-pct">${percentText(meter)}</span>
      <span class="usage-row-detail">${meterPercent(meter) === null ? meterDetail(meter, now) : resetText(meter, now) + (meter.stale ? '. Stale, the last refresh failed' + (meter.error ? ': ' + meter.error : '') : '')}</span>
    </div>`)}
    <div class="usage-foot">${isFinite(updated) && updated > 0 ? 'Checked ' + new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not checked yet'}</div>
  </div>` : null}`;
}
