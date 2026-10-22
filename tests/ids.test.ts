import { describe, expect, it } from 'vitest';
import { newOrderRef, normalisePhone, normaliseRef } from '../src/ids.js';

describe('order refs', () => {
  it('look like ASA- plus six unambiguous characters', () => {
    for (let i = 0; i < 200; i++) expect(newOrderRef()).toMatch(/^ASA-[2-9A-HJKMNP-Z]{6}$/);
  });

  it('survive however a customer types them back', () => {
    expect(normaliseRef('asa 7k2q9f')).toBe('ASA-7K2Q9F');
    expect(normaliseRef('7K2Q9F')).toBe('ASA-7K2Q9F');
    expect(normaliseRef(' ASA-7K2Q9F. ')).toBe('ASA-7K2Q9F');
    expect(normaliseRef('hello')).toBeNull();
    expect(normaliseRef('ASA-7K2Q9')).toBeNull();
  });
});

describe('phones', () => {
  it('normalise Nigerian formats to +234', () => {
    for (const p of ['08031234567', '+234 803 123 4567', '2348031234567', '8031234567', '0803-123-4567']) {
      expect(normalisePhone(p)).toBe('+2348031234567');
    }
  });

  it('reject things that are not a Nigerian mobile number', () => {
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('+447700900123')).toBeNull();
    expect(normalisePhone('')).toBeNull();
  });
});
