import { Redis } from '@upstash/redis';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPaystack } from './paystack.js';
import { createShop } from './shop.js';
import { MemoryStore, RedisStore, type Store } from './store.js';

// builds the real thing from env. shared by the local server and the Vercel function.
export function buildApp(env = process.env) {
  const config = loadConfig(env);
  let store: Store;
  if (config.redisUrl && config.redisToken) {
    store = new RedisStore(new Redis({ url: config.redisUrl, token: config.redisToken }));
  } else {
    console.warn('No Redis configured: holds live in memory and vanish on restart. Fine locally, not in production.');
    store = new MemoryStore();
  }
  const paystack = createPaystack(config.paystackSecret);
  const shop = createShop({ paystack, store, config });
  return createApp({ shop, store, config });
}
