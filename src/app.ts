import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Config } from './config.js';
import type { Shop } from './shop.js';
import type { Store } from './store.js';
import { buildMcpServer } from './tools.js';

interface Deps {
  shop: Shop;
  store: Store;
  config: Config;
}

function tokenMatches(header: string | undefined, token: string) {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp({ shop, config }: Deps) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true, mode: config.paystackSecret.startsWith('sk_test_') ? 'test' : 'live' });
  });

  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    if (!tokenMatches(req.headers.authorization, config.mcpToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // stateless: a fresh server per request, so any instance can answer any call
    const server = buildMcpServer(shop);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp request failed', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  // stateless mode has no sessions to stream or delete
  app.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
  });

  return app;
}
