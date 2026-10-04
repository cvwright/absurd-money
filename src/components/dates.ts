import type { IsoDate } from '@/core/ids.js';

/** Today's date on this device's clock, in local time. */
export function today(): IsoDate {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as IsoDate;
}
