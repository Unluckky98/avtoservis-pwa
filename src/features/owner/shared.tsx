import { fromZonedTime } from 'date-fns-tz';
import { formatInTimeZone } from 'date-fns-tz';

/** "2026-11-02T10:00" typed by the owner in the studio's timezone → exact instant. */
export const localToIso = (local: string, tz: string) => fromZonedTime(local, tz).toISOString();
export const isoToLocalInput = (iso: string, tz: string) => formatInTimeZone(iso, tz, "yyyy-MM-dd'T'HH:mm");
export const dayRange = (day: string, tz: string, days = 1) => ({
  from: fromZonedTime(`${day}T00:00:00`, tz).toISOString(),
  to: fromZonedTime(`${addDay(day, days)}T00:00:00`, tz).toISOString(),
});
function addDay(key: string, n: number) {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = { booked: 'Новая', accepted: 'Подтверждена', done: 'Выполнена', cancelled: 'Отменена', no_show: 'Не приехал' };

export function LabeledInput({ label, type = 'text', value, onChange, min, step }: { label: string; type?: string; value: string; onChange: (v: string) => void; min?: string; step?: number }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-white/80">
      {label}
      <input
        type={type}
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] rounded-xl border border-border bg-surface px-3 text-base text-white"
      />
    </label>
  );
}

export function LabeledSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-white/80">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-h-[44px] rounded-xl border border-border bg-surface px-3 text-base text-white">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
