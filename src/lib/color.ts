export function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Readable label colour on top of an accent fill. */
/** Whichever of black/white gives the higher WCAG contrast against the accent. */
export const onAccent = (hex: string) => {
  const l = luminance(hex);
  return 1.05 / (l + 0.05) > (l + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
};
