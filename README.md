# Àṣà Thrift checkout agent

A WhatsApp shop assistant built on [Chord](https://www.chordhq.xyz) for a (made-up) Lagos thrift seller. It takes a customer from "is this still available?" to a paid sale, using a one-off Paystack bank transfer account per order. It marks the item sold only when Paystack confirms the money. Screenshots and fake alerts don't count.

Everything is invented (shop, stock, customers) and Paystack runs in **test mode**. The server won't start with anything but an `sk_test_` key.

```
customer on WhatsApp ─► Chord teammate ──(MCP, bearer token)──► tool server (Vercel) ──► Paystack test API
 (TSG simulator)        skill/SKILL.md                           find_items               products = stock
                                                                 start_checkout           /charge bank_transfer
                                                                 check_payment            /transaction/verify
                                                                 cancel_checkout
                                         Paystack webhooks ────► /paystack/webhook        Upstash Redis: holds,
                                                                                          orders, once-only markers
```

- **`skill/`**: what makes the agent behave like the shop's own assistant: voice, the hard rules about payment, what to say for every result.
- **`src/`**: the tool server. `shop.ts` is the business logic: holds, stock, and the only code path that can mark an order paid. `paystack.ts` is a thin client, `store.ts` keeps holds in Redis, `http.ts` serves MCP and the webhook.
- **`docs/`**: [field notes](docs/field-notes.md), [go-live note](docs/go-live.md), [design](docs/design.md).

## What it looks like

A full run in the TSG WhatsApp simulator, 22 Oct 2026: availability, a haggle, the hold, "not yet", a bounced wrong amount, then a confirmed sale.

| | | |
|---|---|---|
| ![availability, haggle, hold](docs/screenshots/1-available-haggle-hold.jpg) | ![not yet](docs/screenshots/2-not-yet.jpg) | ![wrong amount then paid](docs/screenshots/3-wrong-amount-then-paid.jpg) |

## Run it locally

```bash
npm install
cp .env.example .env     # Paystack test secret key, Chord key, and a random MCP_TOKEN
npm test                 # 96 tests, Paystack faked, no network
npm run seed             # puts the 10 shop items into your Paystack test account
npm run dev              # tool server on http://localhost:8787 (holds in memory)
npm run smoke -- http://localhost:8787 --checkout
```

## Deploy

```bash
vercel link
vercel integration add upstash/upstash-kv    # Redis for holds; accept the terms in the browser when asked
vercel env add PAYSTACK_SECRET_KEY production
vercel env add MCP_TOKEN production
vercel deploy --prod
```

Then set the Paystack **test** webhook URL to `https://<your-deployment>/paystack/webhook`.

## Connect it to Chord

1. **Admin → Channels & Tools → Tools → Custom tools**: add `https://<your-deployment>/mcp`, `streamable_http`, bearer `MCP_TOKEN`. Create it **disabled**. An enabled server goes to every teammate that hasn't been pinned.
2. **Create a teammate** from `dist/asa-thrift-skill.zip` (`./scripts/pack-skill.sh`), with autonomy **Act independently**.
3. **Pin it to the server.** This is API-only, and the server id is only visible in the app's network tab (see field notes #2):
   ```bash
   npm run chord -- pin <teammate-id> <mcp-server-id>
   ```
4. Enable the server, then test with `npm run chord -- say "is the corduroy jacket still available?"` or in the TSG WhatsApp simulator.
5. Later skill edits go straight from the repo: `npm run chord -- publish-skill "what changed"`.

## Paying in test mode

Use Paystack's [demo bank](https://demobank.paystackintegrations.com/) to send a transfer to the account number the agent gives you. Send the wrong amount first if you want to see the bounce.
