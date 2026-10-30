import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { House, Wrench, CalendarCheck } from '@phosphor-icons/react';
import { prefersReducedMotion } from '../lib/motion';

const items = [
  { to: '', label: 'Главная', Icon: House, end: true },
  { to: 'services', label: 'Услуги', Icon: Wrench, end: false },
  { to: 'my', label: 'Моя запись', Icon: CalendarCheck, end: false },
] as const;

/**
 * Floating navigation. A CSS backdrop-filter glass is always present. The liquid-gl refraction layer
 * (WebGPU) is OFF by default: it was never verified on real devices and is suspected of freezing
 * iOS Safari. Opt in for testing with `?glass=lens`.
 */
export function GlassNav() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty('--nav-h', `${el.offsetHeight + 10}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || new URLSearchParams(location.search).get('glass') !== 'lens') return;
    let cancelled = false;
    let lens: { destroy?: () => void } | undefined;
    // Refraction only where a real GPU adapter exists; software renderers produce visual noise.
    // Everywhere else the CSS glass above is what the user sees.
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    void (gpu ? gpu.requestAdapter().catch(() => null) : Promise.resolve(null))
      .then((adapter) => (adapter && !cancelled ? import('liquid-gl') : null))
      .then((m) => {
        if (!m || cancelled) return;
        const liquidGL = (m.default ?? m) as unknown as (o: Record<string, unknown>) => unknown;
        const out = liquidGL({ target: '.bottom-nav', snapshot: 'body', resolution: 1.5, refraction: 0.012, bevelDepth: 0.06, bevelWidth: 0.2, frost: 2, shadow: true, specular: false, reveal: 'none', engine: 'webgpu' });
        lens = Array.isArray(out) ? (out[0] as typeof lens) : (out as typeof lens);
      })
      .catch(() => {
        /* the CSS glass stays */
      });
    return () => {
      cancelled = true;
      try {
        lens?.destroy?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return (
    <nav ref={ref} className="bottom-nav glass" aria-label="Основная навигация">
      <ul className="flex items-stretch justify-around p-1.5 m-0 list-none">
        {items.map(({ to, label, Icon, end }) => (
          <li key={label} className="flex-1">
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 rounded-3xl px-2 py-2 text-[11px] font-medium no-underline min-h-[52px] justify-center ${isActive ? 'text-white glass-accent' : 'text-white/70'}`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={24} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
