# Àṣà Thrift checkout agent: design

## Why this exists

Small Lagos fashion and thrift sellers sell mostly through Instagram and WhatsApp, and most customers pay by bank transfer, usually because their card isn't on them at that moment. The seller then has to work out whether the money actually arrived. "Flash fund" apps make convincing fake credit alerts and screenshots (bank logo, the seller's name and account number, a made-up reference). Sellers have lost cars, phones and stock to them. The only safe check is the bank's back end, which means the owner opening the bank app for every sale.

For a thrift seller this is worse than usual. Most pieces are one of one, so a fake alert loses the item for good, and an item "on hold" for someone who never pays is an item nobody else can buy.

**The agent's one job:** take a customer from "is this still available?" to a confirmed, paid sale over WhatsApp. Payment is confirmed only by Paystack, never by a screenshot or the customer's word, and the item is marked sold only then.

**Why the owner would pay for it:** one stopped fake alert covers months of the fee, and the owner no longer stops what they're doing to check the bank app before every sale.

This is a submission for the TSG Labs build exercise (Forward-deployed Engineering). The business is invented. All data is made up and Paystack runs in test mode only.

## The business (invented)

**Àṣà Thrift, Yaba, Lagos.** A one-person curated thrift and vintage shop that sells on Instagram and WhatsApp. Stock is mostly single pieces: jackets, shirts, dresses, bags, with the occasional item that has two or three in stock. Prices are typically ₦8,000 to ₦45,000. The owner posts pieces on Instagram, and customers message on WhatsApp to buy. Delivery is arranged by the owner after payment, through a dispatch rider.

The skill must give the agent enough of this context (name, location, tone, opening hours, how delivery works, what it can and can't do) that it reads like the shop's own assistant.

## The flow

The customer always sends the next message. The agent never has to start a conversation. That's deliberate: a previous builder found that Chord tools can't see who the customer is, and that messaging a customer first is hard. See "Known platform constraints".

1. **Availability.** "Is the brown corduroy jacket still available?" The agent looks up live stock and price and replies with price, size and condition. If it's held by someone else or sold, it says so plainly and can suggest similar available items.
2. **Checkout.** "I'll take it." The agent collects a name and a phone number for delivery, then starts checkout. That holds the item and gets a one-off Paystack account number for the exact amount. It replies with the bank name, account number, account name, exact amount, and when the number expires (default 30 minutes). It also says to transfer the exact amount, because a wrong amount gets bounced.
3. **"I've sent it."** With or without a screenshot. The agent doesn't evaluate screenshots. It checks with Paystack:
   - **Paid in full:** the tool marks the item sold in Paystack and records the order as paid. The agent sends a confident, reassuring confirmation, for example: "Payment received: ₦18,500, confirmed by Paystack. The corduroy jacket is yours and it's off the rail. We'll message you today to arrange delivery." It should read as certain, because it is.
   - **Not arrived yet:** calm and specific: transfers can take a few minutes, the hold stays until [time], message again once your bank shows it's gone.
   - **Wrong amount, rejected by Paystack:** explain that the amount didn't match, so it was returned to their bank. Give them the exact amount to send, and issue a fresh account number if the hold has expired.
   - **Expired before payment:** the hold has lapsed and the item may be back on sale. If it's still available, offer a fresh account number. If someone else bought it, say so and suggest alternatives.
   - **Already confirmed:** if they ask again, confirm again without double-processing anything.
4. **Haggling.** "Last price?" The listed price is the price. The agent says politely that there's no discount on that piece. If the customer keeps pushing, it hands the conversation to the owner (Chord human handover) rather than negotiating. Price changes are the owner's job: they edit the price in the Paystack dashboard, and the agent always reads the live price.
5. **Anything outside its job.** Complaints, returns, delivery problems, a payment that landed for an item that's no longer available, or a customer asking for a person: hand over to the owner.

## Systems

- **Paystack (test mode) is both the payment rail and the stock list.**
  - *Stock:* Paystack Products. Each item has `quantity`, `quantity_sold` and `in_stock`, and the owner can see and edit them in the dashboard. The agent reads live price and availability from here. When a payment is confirmed, the tool reduces the quantity. There's no Google Sheet or other second stock list.
  - *Payment:* Paystack Pay with Transfer (`POST /charge` with a `bank_transfer` object). It returns a temporary account number tied to one transaction and an exact amount, with an expiry between 15 minutes and 8 hours. In test mode the bank is "Test Bank".
  - *Confirmation:* `GET /transaction/verify/:reference`. Use `data.status` and `data.amount`, never the top-level `status`, which only means the API call worked. Paystack sends `bank.transfer.rejected` when a customer sends the wrong amount or is flagged by fraud checks, and `charge.success` on payment. Webhooks may arrive more than once.
- **The tool server.** A small TypeScript MCP server (Streamable HTTP, public HTTPS, bearer auth), the only way Chord can call custom tools. It owns all money and stock logic.
- **Holds.** The owner also sells outside the agent, in Instagram DMs and in person. So a held item must look unavailable in Paystack too. Starting a checkout reduces the item's Paystack `quantity` by one immediately. A confirmed payment keeps it reduced. An expired or cancelled hold adds one back, relative to the current quantity, so a stock change the owner made by hand isn't overwritten. Paystack has no "reserved" state, so the tool server also keeps its own record of holds and orders: who holds what, until when, and which charge reference. That record must survive restarts and redeploys. Storage choice is left to the builder.
- **Chord.** One teammate made from a skill I write, assigned to this MCP server only, tested in the WhatsApp simulator (chat.tsglabs.dev). Human handover and escalation email are Chord's built-in features.

## The tools (what the agent can call)

The model never decides an amount, never marks anything sold itself, and never confirms a payment from what the customer says. All of that is in code.

- **Find items:** search available stock by description. Returns name, price, size, condition, and whether it's available, held or sold. Items held by someone else count as unavailable.
- **Start checkout** (item, customer name, phone): refuses if the item is sold or held by someone else. Otherwise it creates the hold and the Pay with Transfer charge for the live Paystack price, and returns bank, account number, account name, amount, expiry and an order reference. If the same customer already has a live hold on that item, it returns the existing account details instead of creating a second charge. It never retries charge creation blindly, because a retry after a timeout could create two charges.
- **Check payment** (order reference): asks Paystack, then returns one clear state: paid (the order is finalised as sold; stock was already reduced at checkout), not yet, rejected for the wrong amount, expired (the hold is released and stock goes back up by one, once), or already confirmed. Every state change happens at most once per order, however many times it's called or a webhook repeats.
- **Cancel checkout** (order reference): releases the hold if the customer changes their mind.

A webhook receiver for Paystack events (`charge.success`, `bank.transfer.rejected`) is optional. Build it if it makes the rejected-amount and late-payment cases reliable, since verify alone may not show a rejection. It must verify Paystack's signature and be idempotent.

## Errors that must be handled, not ignored

- Paystack unreachable, slow, or returning an error: tell the customer plainly that payment can't be confirmed right now and nothing has been marked sold. Never invent a result.
- Empty or unexpected responses (no product found, a charge response with no account number): treat as a failure with a clear message, not a success.
- Wrong amount, expired account, payment on a released hold, a duplicate "I've paid", and a duplicate webhook.
- A test-mode guard: the server refuses to start with a key that isn't `sk_test_`.
- Messages to the customer never contain raw errors, stack traces or keys.

## Goals

- One complete conversation in the WhatsApp simulator, from "is it available?" to a Paystack-confirmed sale, where the stock in the Paystack dashboard visibly changes.
- At least one failure path shown working (a wrong amount, "not arrived yet", or an item that's already taken).
- Left live on the Chord account for reviewers to try.
- Deliverables: repo with skill files and tool code plus a short README; a 3-minute recording; deployment field notes written from problems actually hit during the build; a half-page go-live note for the owner.

## Non-goals (deliberately left out)

- Discounts and negotiation. The price is the price. Persistent hagglers go to the owner.
- Delivery booking or tracking. The owner arranges delivery after payment.
- Returns and refunds. These go to the owner.
- Card payments and payment links. This is about bank transfer.
- Several items in one order. One item per checkout keeps holds simple and honest. A customer can do two checkouts.
- Reading or judging screenshots.
- Messaging customers first (reminders, "your hold is about to expire").
- An owner settings page or dashboard. The Paystack dashboard is the owner's view.

## Anti-goals (would make this a failure even if it "works")

- The agent ever tells a customer their payment is confirmed when Paystack hasn't said so.
- An item is sold twice, or marked sold twice for one payment.
- The model can choose or change a price.
- A customer sees a raw error, a stack trace, or anything that looks like a key.
- It sounds like a generic chatbot rather than the shop.

## Tone and style (for the skill)

- Warm, quick, a little Lagos. It understands Pidgin and casual messages ("abeg is it still available", "I don send am") and replies in clear, friendly English with light local phrasing. No overdoing it.
- Short WhatsApp-sized messages. WhatsApp formatting only (`*bold*` with single asterisks, no Markdown headings or `**`), since a previous builder saw Markdown arrive as raw asterisks in the simulator.
- Account details laid out so they're easy to copy: bank, account number and amount each on their own line.
- Confirmations are certain and specific (amount, item, "confirmed by Paystack"). Waiting messages are calm and give a time.

## Known platform constraints (from the docs and another builder's public notes; what I actually saw is in field-notes.md)

- Chord custom tools are remote MCP servers only, at a public HTTPS URL. Loopback and private addresses are blocked.
- A teammate with no MCP assignment gets every enabled server in the workspace. Pin the teammate to this server (`set_mcp_server_ids`). The other builder found this was API-only.
- Tool calls reportedly carry no sender, conversation or channel information, so the tool can't identify the WhatsApp customer. The order reference from the conversation is what ties a payment check to an order.
- Messaging a customer first through Chord needs a conversation id that's hard to obtain, which is why the flow is always customer-initiated.
- Things to check first, because the plan depends on them: (1) the simulator reaches my teammate and the teammate calls my tool; (2) how to simulate a customer's transfer into a Pay with Transfer account in Paystack test mode, and what verify returns for paid, pending, expired and wrong-amount cases; (3) whether Paystack test mode charges fees on Pay with Transfer that change the amount the customer must send; (4) that human handover works from the simulator and the owner gets notified.

## Key decisions

- **Paystack Products is the stock list**, not a Sheet or Airtable. The owner already uses the dashboard, and payments and stock can't drift apart.
- **Pay with Transfer**, one account per order with an exact amount and an expiry, rather than permanent virtual accounts. Nothing to set up per customer, and a wrong amount is bounced by Paystack.
- **Holds take stock off Paystack at checkout**, because the owner also sells in DMs and in person.
- **No discounts.** The owner changes prices in Paystack; persistent hagglers go to the owner.
- **One item per order, 30-minute holds.**
- **The confirmation is confident and specific**, because it's only ever sent after Paystack confirms.

## Fallbacks

- **If Pay with Transfer can't be paid in test mode** (I can't simulate the incoming transfer, or verify never moves off pending), switch to a test Dedicated Virtual Account (`preferred_bank: "test-bank"`) for that customer. It's still a bank transfer and still confirmed by Paystack. If neither can be paid in test mode, use a Paystack checkout limited to the bank-transfer channel. In every case, **never forge or self-sign Paystack webhooks for the live demo**. The wrong-amount case may then only be shown in automated tests with a faked Paystack, and the field notes say so.
- **If Chord's human handover doesn't work from the simulator**, the agent tells the customer plainly that the owner will need to pick this up and gives the shop's (invented) contact line. The gap goes in the field notes. No custom email tool unless it turns out to be cheap.

## Owner notifications

- Every charge carries the order in its Paystack metadata: item, buyer name, delivery phone and order reference. A paid order is fully readable on the Paystack transaction page.
- The owner learns about sales from Paystack's own merchant notifications and the dashboard. I'm not building a notification system. Whether test mode sends those emails needs checking; the go-live note covers it either way.
- Handover (haggling, complaints, edge cases) is Chord's escalation path. It is not used for ordinary sales, because a handover takes the thread away from the agent.

## Decided during the build

- Hosting provider and storage for holds and orders (it must be public HTTPS, must not sleep between calls during review, and holds must persist).
- Exact tool names, schemas and response shapes.
- Seed data: about 8 to 12 invented items created through the Paystack Products API in test mode.
- How holds expire: lazily on the next lookup, or on a timer.
- Whether to build the webhook receiver, based on what verify shows in test mode.
- Test approach. Paystack should be fakeable in tests, so they run without network.
