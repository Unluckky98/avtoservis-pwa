import { describe, expect, it } from 'vitest';
import { formatRuPhone, isRuPhoneComplete, normalizeRuPhone } from '../../src/lib/phone';
import { CAR_OTHER, carString } from '../../src/lib/cars';

describe('RU phone mask', () => {
  it('formats progressively and drops the country digit', () => {
    expect(formatRuPhone('')).toBe('');
    expect(formatRuPhone('9')).toBe('+7 (9');
    expect(formatRuPhone('912')).toBe('+7 (912');
    expect(formatRuPhone('9123')).toBe('+7 (912) 3');
    expect(formatRuPhone('9123456789')).toBe('+7 (912) 345-67-89');
  });
  it('accepts 8…, 7…, +7… and pasted text', () => {
    for (const v of ['89123456789', '79123456789', '+7 912 345-67-89', '+7 (912) 345-67-89']) expect(formatRuPhone(v)).toBe('+7 (912) 345-67-89');
    expect(formatRuPhone('912345678999999')).toBe('+7 (912) 345-67-89');
  });
  it('lets Backspace delete the punctuation', () => {
    expect(formatRuPhone('+7 (912')).toBe('+7 (912');
    expect(formatRuPhone('+7 (912) ')).toBe('+7 (912');
    expect(formatRuPhone('+7 (')).toBe('');
    expect(formatRuPhone('+7')).toBe('');
  });
  it('normalizes to +7XXXXXXXXXX and checks completeness', () => {
    expect(normalizeRuPhone('+7 (912) 345-67-89')).toBe('+79123456789');
    expect(isRuPhoneComplete('+7 (912) 345-67')).toBe(false);
    expect(isRuPhoneComplete('+7 (912) 345-67-89')).toBe(true);
  });
});

describe('car string', () => {
  it('joins brand and model, or uses the typed text', () => {
    expect(carString({ brand: 'Porsche', model: 'Panamera', custom: '' })).toBe('Porsche Panamera');
    expect(carString({ brand: 'Porsche', model: CAR_OTHER, custom: ' Cayenne Coupe ' })).toBe('Porsche Cayenne Coupe');
    expect(carString({ brand: CAR_OTHER, model: '', custom: 'Zeekr 001' })).toBe('Zeekr 001');
    expect(carString({ brand: '', model: '', custom: '' })).toBe('');
  });
});
