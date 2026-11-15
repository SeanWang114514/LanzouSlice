export function roundedBytes(value, perSecond = false) {
  let amount = Number.isFinite(value) ? Math.max(0, value) : 0, unit = 0;
  while ((perSecond ? Number(amount.toFixed(2)) : Math.round(amount)) >= 1024 && unit < 4) { amount /= 1024; unit++; }
  return `${perSecond ? amount.toFixed(2) : Math.round(amount)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}${perSecond ? '/s' : ''}`;
}
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds), days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24, minutes = Math.floor(total / 60) % 60, rest = total % 60;
  return `${days ? `${days}天 ` : ''}${[hours, minutes, rest].map(value => String(value).padStart(2, '0')).join(':')}`;
}
