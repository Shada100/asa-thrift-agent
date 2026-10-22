export interface Config {
  paystackSecret: string;
  mcpToken: string;
  holdMinutes: number;
  customerEmailDomain: string;
  redisUrl?: string;
  redisToken?: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const paystackSecret = env.PAYSTACK_SECRET_KEY?.trim() ?? '';
  // hard stop: this build only ever talks to Paystack test mode
  if (!paystackSecret.startsWith('sk_test_')) {
    throw new Error('PAYSTACK_SECRET_KEY must be a test key (sk_test_...)');
  }

  const mcpToken = env.MCP_TOKEN?.trim();
  if (!mcpToken) throw new Error('MCP_TOKEN is required');

  const holdMinutes = Number(env.HOLD_MINUTES ?? 30);

  return {
    paystackSecret,
    mcpToken,
    holdMinutes: Number.isFinite(holdMinutes) && holdMinutes > 0 ? holdMinutes : 30,
    customerEmailDomain: env.CUSTOMER_EMAIL_DOMAIN?.trim() || 'example.com',
    // Vercel's Upstash integration names these KV_REST_API_*, the Upstash console names them UPSTASH_REDIS_REST_*
    redisUrl: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
    redisToken: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
  };
}
