import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('rejects a live key', () => {
    expect(() => loadConfig({ PAYSTACK_SECRET_KEY: 'sk_live_x', MCP_TOKEN: 't' })).toThrow(/test key/);
  });

  it('requires an MCP token', () => {
    expect(() => loadConfig({ PAYSTACK_SECRET_KEY: 'sk_test_x' })).toThrow(/MCP_TOKEN/);
  });

  it('defaults hold to 30 minutes', () => {
    expect(loadConfig({ PAYSTACK_SECRET_KEY: 'sk_test_x', MCP_TOKEN: 't' }).holdMinutes).toBe(30);
  });
});
