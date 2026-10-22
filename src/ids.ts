import { randomInt } from 'node:crypto';

// no 0/O, 1/I/L so a ref read out over the phone or retyped from a screenshot still works
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const REF_BODY = new RegExp(`^[${ALPHABET}]{6}$`);

export function newOrderRef(): string {
  let body = '';
  for (let i = 0; i < 6; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `ASA-${body}`;
}

export function normaliseRef(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('ASA') && s.length === 9) s = s.slice(3);
  return REF_BODY.test(s) ? `ASA-${s}` : null;
}

// Nigerian mobiles: 0 + 10 digits locally, 234 + 10 digits internationally, and the
// 10 digits always start 7, 8 or 9 (0803, 0905, 0701...)
export function normalisePhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('234')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return /^[789]\d{9}$/.test(d) ? `+234${d}` : null;
}
