import { useMemo, type ReactNode } from 'react';
import { Theme, defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { themes, defaultThemeSlug } from '../astryx-themes';
import { onAccent } from '../lib/color';

const DEFAULT_ACCENT = '#4690FF';

/** Dark, black-background theme whose single accent colour comes from the studio config. */
export function StudioTheme({ accent, children }: { accent?: string | null; children: ReactNode }) {
  const theme = useMemo(() => {
    const a = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : DEFAULT_ACCENT;
    return defineTheme({
      name: `studio-${a.slice(1)}`,
      extends: themes[defaultThemeSlug] ?? neutralTheme,
      tokens: {
        '--color-accent': [a, a],
        '--color-on-accent': [onAccent(a), onAccent(a)],
        '--color-background-body': ['#060912', '#060912'],
        '--color-background-surface': ['#0c1224', '#0c1224'],
        '--color-background-popover': ['#0c1224', '#0c1224'],
        '--color-background-card': ['#0c1224', '#0c1224'],
        '--focus-outline-color': 'var(--color-accent)',
      },
    });
  }, [accent]);
  return (
    <Theme theme={theme} mode="dark">
      {children}
    </Theme>
  );
}
