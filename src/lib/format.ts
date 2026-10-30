import { formatInTimeZone } from 'date-fns-tz';
import { ru } from 'date-fns/locale';

export const rub = (cents: number) => `${new Intl.NumberFormat('ru-RU').format(Math.round(cents / 100))} ₽`;

export function duration(min: number): string {
  if (min % 1440 === 0) {
    const d = min / 1440;
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const dayKey = (iso: string, tz: string) => formatInTimeZone(iso, tz, 'yyyy-MM-dd');
export const timeLabel = (iso: string, tz: string) => formatInTimeZone(iso, tz, 'HH:mm');
export const dateLabel = (iso: string, tz: string) => formatInTimeZone(iso, tz, 'EEEE, d MMMM', { locale: ru });
export const dateShort = (iso: string, tz: string) => formatInTimeZone(iso, tz, 'd MMM', { locale: ru });
export const weekdayShort = (iso: string, tz: string) => formatInTimeZone(iso, tz, 'EEEEEE', { locale: ru });
export { todayKey as todayIn, addDaysKey } from '../shared/periods';

export const WEEKDAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
