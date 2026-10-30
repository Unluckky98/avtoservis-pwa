/** Russian phone mask: "+7 (900) 123-45-67". Works on the typed/pasted text, so it also accepts 8..., 7... and bare 9... */
export function ruDigits(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('7') || d.startsWith('8')) d = d.slice(1);
  return d.slice(0, 10);
}

/** Punctuation is added only together with the next digit, so Backspace can always delete it. */
export function formatRuPhone(input: string): string {
  const d = ruDigits(input);
  if (!d) return '';
  let out = `+7 (${d.slice(0, 3)}`;
  if (d.length > 3) out += `) ${d.slice(3, 6)}`;
  if (d.length > 6) out += `-${d.slice(6, 8)}`;
  if (d.length > 8) out += `-${d.slice(8, 10)}`;
  return out;
}

export const normalizeRuPhone = (input: string): string => `+7${ruDigits(input)}`;
export const isRuPhoneComplete = (input: string): boolean => ruDigits(input).length === 10;
