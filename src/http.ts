import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Config } from './config.js';
import { normaliseRef } from './ids.js';
import { verifyWebhookSignature } from './paystack.js';
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

export function createApp({ shop, store, config }: Deps) {
  const app = express();

  app.get('/', (_req, res) => {
    res.type('text').send('Àṣà Thrift tool server. Chord talks to /mcp, Paystack to /paystack/webhook.');
  });

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

  app.post('/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyWebhookSignature(raw, req.header('x-paystack-signature'), config.paystackSecret)) {
      res.status(401).json({ error: 'bad signature' });
      return;
    }

    let evt: { event?: string; data?: any };
    try {
      evt = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: 'bad json' });
      return;
    }
    const data = evt.data ?? {};
    // test mode only, so it's fine to keep the whole thing while we learn the payload shapes
    console.log('paystack webhook', evt.event, raw.slice(0, 4000));

    // paystack retries, so the same event can turn up more than once
    // rejected events have no data.id, the transfer id lives under bank_transfer
    const eventId = data.id ?? data.bank_transfer?.transaction_id ?? createHash('sha256').update(raw).digest('hex');
    const eventKey = `evt:${evt.event}:${eventId}`;
    if (!(await store.once(eventKey))) {
      res.sendStatus(200);
      return;
    }

    try {
      if (evt.event === 'charge.success' && data.reference) {
        // don't take the event's word for it, ask Paystack (same path the agent uses)
        await shop.checkPayment({ orderRef: String(data.reference) });
      } else if (evt.event === 'bank.transfer.rejected') {
        const ref = await refForRejection(data);
        const why = data.bank_transfer?.message ?? data.reason ?? data.gateway_response ?? data.message ?? 'transfer rejected';
        if (ref) await store.markRejected(ref, String(why));
        else console.warn('bank.transfer.rejected for an order we could not match');
      }
    } catch (err) {
      // still 200: a retry won't fix our bug, and the agent re-checks with Paystack anyway
      console.error('webhook handling failed', err);
    }
    res.sendStatus(200);
  });

  // paystack's docs have no sample of this event. the real one (seen in test mode) puts our ref
  // at data.bank_transfer.reference; the other spots are kept in case the shape varies.
  async function refForRejection(data: any): Promise<string | null> {
    for (const candidate of [data.bank_transfer?.reference, data.reference, data.transaction_reference, data.metadata?.order_ref]) {
      const ref = typeof candidate === 'string' ? normaliseRef(candidate) : null;
      if (ref && (await store.getOrder(ref))) return ref;
    }
    const account = data.account_number ?? data.receiver_bank_account_number ?? data.authorization?.receiver_bank_account_number;
    if (!account) return null;
    const match = (await store.activeHolds()).find((o) => o.accountNumber === String(account));
    return match?.ref ?? null;
  }

  // stateless mode has no sessions to stream or delete
  app.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
  });

  return app;
}
