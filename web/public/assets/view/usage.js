// Plan usage meters in the terminal header. The agent sends one snapshot with a meter per
// window: percent used, reset time, and whether the value is stale or unavailable. Each meter
// is a small bar with its percent and reset time. A click or tap opens a panel
// that lists every window with its reset time.
import { html } from './html.js';

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
  return percent === null ? 'unavailable' : Math.round(percent) + '%';
}

// "37h". Minutes under an hour, hours under two days, whole days after that. Empty without a reset time.
export function untilText(meter, now = Date.now()) {
  const at = Number(meter?.resetsAt);
  if (!isFinite(at) || at <= 0) return '';
  const minutes = Math.max(0, Math.round((at - now) / 60000));
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

export function resetText(meter, now = Date.now()) {
  const until = untilText(meter, now);
  return until ? 'resets in ' + until : 'reset time unknown';
}

export function meterDetail(meter, now = Date.now()) {
  if (meterPercent(meter) === null) return ['unavailable' + (meter?.error ? ': ' + meter.error : ''), Number(meter?.resetsAt) > 0 ? 'last known ' + resetText(meter, now) : ''].filter(Boolean).join(', ');
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
  const until = untilText(meter, now);
  // Phones show only the number after the percent; the words hide there.
  const words = (percent === null && until ? 'last known ' : '') + (until ? 'resets in ' : 'reset time ');
  return html`<span class=${cls} data-key=${meter.key} title=${meterTooltip(meter, now)}>
    <span class="meter-label">${meter.label}</span>
    <span class="meter-bar" aria-hidden="true"><span class="meter-fill" style=${'width:' + (percent === null ? 0 : percent) + '%'}></span></span>
    <span class="meter-values"><span class="meter-pct">${percentText(meter)}</span> <span class="meter-reset"><span class="meter-reset-words">${words}</span>${until || 'unknown'}</span></span>
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
