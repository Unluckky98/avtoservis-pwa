import type { Booking } from './api';

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export function buildIcs(b: Booking, studio: { name: string; address: string | null; phone: string | null }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//avtoservis-pwa//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@avtoservis-pwa`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(b.starts_at)}`,
    `DTEND:${stamp(b.ends_at)}`,
    `SUMMARY:${esc(`${b.service_name} — ${studio.name}`)}`,
    ...(studio.address ? [`LOCATION:${esc(studio.address)}`] : []),
    `DESCRIPTION:${esc(`Запись в «${studio.name}».${studio.phone ? ` Телефон: ${studio.phone}.` : ''}`)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Запись завтра',
    'TRIGGER:-PT24H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

export function downloadIcs(b: Booking, studio: { name: string; address: string | null; phone: string | null }) {
  const blob = new Blob([buildIcs(b, studio)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'zapis.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
