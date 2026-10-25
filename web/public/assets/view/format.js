// Text formatting for durations, ages and sizes. Ages take the current time as an argument so a
// view drawn from the store shows the same text for the same state.

export function fmtSecs(input) {
  const s = Math.max(0, Math.round(Number(input) || 0));
  if (s < 60) return s + (s === 1 ? ' second' : ' seconds');
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes') + (rs ? ' ' + rs + 's' : '');
  const hr = Math.floor(m / 60), rm = m % 60;
  return hr + (hr === 1 ? ' hour' : ' hours') + (rm ? ' ' + rm + 'm' : '');
}

export function fmtAge(ms, now = Date.now()) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const s = Math.floor((now - n) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const hr = Math.floor(m / 60); if (hr < 48) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

export function fmtShortAge(ms, now = Date.now()) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const seconds = Math.max(0, Math.floor((now - n) / 1000));
  if (seconds < 60) return '<1m';
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60); if (hours < 48) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KiB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MiB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
}
