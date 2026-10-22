# Deployment field notes

Three Chord problems first, the ones that cost the most time or would cost the next builder. Then what Paystack taught me, then the small stuff. Everything here happened on 22 October 2026 while building and running this agent. Where another builder had already reported something publicly, I say so and what I saw myself.

## 1. The agent kept "confessing" to mistakes it never made, because it can't see its own past tool calls

**What happened.** Four times, the agent told a customer it had lied earlier:
- *"I owe you a correction, Tolu… I hadn't actually checked before sending them."* (after a wrong-amount transfer; screenshot [3-wrong-amount-then-paid.jpg](screenshots/3-wrong-amount-then-paid.jpg))
- *"Earlier I told you the order was cancelled, but I hadn't actually cancelled it at that point."* (in a new chat, after a real cancel)
- *"I can't confirm that my earlier cancellation actually went through, since I never ran it."*
- *"Correction to what I said earlier: the hold on the skirt was real"* (same session, one message later)

For a payments agent this is the worst thing it can say. The customer stops believing every confirmation after it.

**How I found the cause.**
1. *Were the claims true?* No.
   - Vercel's request logs show a tool call for every "I've paid" (12:59:06, 13:04:00, 13:07:46 UTC).
   - For the cancel, Paystack's product record shows `updatedAt 14:17:23` with quantity back to 1, the same second as the cancel's tool call.
2. *Could I see the conversation?* No.
   - `GET /v1/threads/{id}/turns` → `403 Missing required permission: thread:read`.
   - `GET …/teammates/{id}/memories` → `403 Missing required permission: memory:read`.
   - The key screen offers neither permission.
3. *Reproduce it.* I replayed it over `/v1/external-chat/messages`: checkout, cancel, then a new session for the same sender. Two of four replies confessed, and the wording gave the mechanism away: *"since I never ran it"*, *"No order or payment account has been set up for you in this chat."*
   - My reading: the replayed history has the **text** of the agent's earlier replies but not the **tool calls** behind them.
   - So the model sees itself quoting an account number with no tool call in view, and the skill says never invent anything. It concludes its own message was invented, and "corrects" it.
4. *Is it my skill wording?* I had quoted the forbidden phrases, which can prime a model to say them. I rewrote the rule positively and nothing changed, so that wasn't the cause.

**What I did.**
- **The tools now carry their own history.** A repeat cancel used to answer `cancelled` again, as if it had just happened. Now it returns `alreadyCancelled: true, cancelledAtLagos: "3:35pm"`. A cancelled order no longer reads as "expired" either (tests in `tests/shop.payment.test.ts`).
- **The skill tells the model exactly what it can't see.** Earlier replies quoting an order ref, account number or cancellation came from real tool calls it can't see any more. When in doubt, call `check_payment` or `cancel_checkout` with the ref.
- **Result:** across three replays of the same scenario, 0 of 12 replies made up a mistake, against 4 of 8 before. The agent now checks and says *"cancelled at 3:35pm, so you're all set."*

**What I'd change in Chord.**
- Include previous turns' tool calls and results in the replayed history, or at least a one-line summary per call.
- Offer `thread:read` and `memory:read` on the API key screen.
- Put tool *results*, not just tool names, in the `steps` that `/v1/external-chat/messages` returns. With those, this would have been a ten-minute diagnosis instead of an afternoon.

## 2. Pinning a teammate to its tool server is API-only, and the API won't give you the id

**What happened.** The shop's tools create real payment accounts, so they should belong to the shop teammate only. In Chord, a teammate with no MCP assignment gets *every* enabled server in the workspace. Assignment is only possible through `PUT /v1/teammates/{id}` with `set_mcp_server_ids`, and that needs the server's `mcp-…` id.

**How I found the cause.** `GET /v1/workspaces/{ws}/mcp-servers` → `403 Missing required permission: mcp:read`. The key screen offers Chat, Knowledge, Teammates, Procedures, Usage and Webhooks, but no MCP scopes. The app doesn't show the id on the server's page either. The other builder hit this too; I confirmed it with my own key.

**What I did.** I had the owner open the browser's network tab on the Custom tools page and copy the id from the `mcp-servers` response. Then `npm run chord -- pin <teammate> <server>` and a read-back: `mcp_server_ids = ["mcp-e610c1f6-…"]`.

**What's still wrong.** The workspace's default "Chord Assistant" keeps an empty assignment, which means it *also* gets the shop's payment tools. The docs are explicit that an empty list "is not a way to deny MCP access". There is no way to say "none".

**What I'd change in Chord.**
- Show the server id in the app.
- Add MCP scopes to the key screen.
- Add a per-teammate MCP picker in Teammate settings → Tools.
- Make "all servers" an explicit choice instead of what an empty list silently means.

## 3. Everything the model writes goes to the customer, including its working

**What happened.** The first checkout reply, sent through Chord, started with:

> "The expiry time (13:11 UTC, which is 2:11pm Lagos) is only about 30 minutes from now, so I'll use that."

That's the model talking to itself, delivered to a customer.

**How I found the cause.** My skill told the model to convert the tool's UTC `expiresAt` into Lagos time. It did, then narrated the conversion, and Chord passed the whole reply through.

**What I did.** I moved the arithmetic out of the model. The tools now return `expiresAtLagos: "2:11pm"` (with tests), and the skill says to use those fields as-is and never think out loud. Every simulator reply since has been clean.

**What I'd change in Chord.** Give the model a way to write notes that don't reach the channel, or tell it in the system prompt that every token it writes is delivered on WhatsApp. Also document that tool output should carry customer-ready values, so builders design for it from the start.

## What Paystack taught me (not Chord's fault, but it shaped the build)

**A. A wrong-amount transfer looks paid to the customer, and Paystack only reports the rejection once.**
- *Wrong-amount behaviour.* Pay with Transfer bounces any amount that doesn't match. In the demo bank, the ₦500 and ₦10,000 short payments showed as **successful transfers**, so the customer believes they've paid.
- *What verify shows.* A verify straight after reads `ongoing`, gateway response "Awaiting Transfer".
- *The first rejection.* Paystack sent a `bank.transfer.rejected` webhook. Its docs list that event but give no sample. My guessed parser looked for the reference in the wrong place: it's at `data.bank_transfer.reference`, and there's no `data.id`. So the first rejection went unrecorded, and the customer was told "not received yet".
- *The fix.* I captured the real payload from my own logs, wrote tests from it, and fixed the parser and the dedupe key.
- *The second rejection sent no webhook at all.* But by then, verify's `gateway_response` had changed to "incorrect amount sent". The agent now treats either signal as a bounce, and the simulator then said: "Paystack couldn't accept your transfer because the amount didn't match, so your bank will return the money."

**B. Status names don't mean what the docs suggest.**
- An untouched transfer charge reads `ongoing`, not `pending` or `abandoned`.
- One flipped to `abandoned` ("Can't requery test transaction") 13 minutes *before* its account expired.

I stopped keying anything off status names except `success`. Expiry is decided by our own clock against the `account_expires_at` Paystack returned.

**C. Paystack rejects `.test` emails.** `POST /charge` returned `400 "email" must be a valid email` for `…@asathrift.test`. Customers on WhatsApp don't have an email anyway, so each order uses `<ref>@example.com`, which is reserved so no receipt reaches a real person.

**D. Same transaction, two events.** The `charge.success` `data.id` equals the rejected event's `bank_transfer.transaction_id`. The dedupe key includes the event name, so they don't collide. Worth knowing before you write one.

## Smaller things

- **Handover leaves the customer in silence.** On a second haggle push the agent handed over to the owner, as the skill says. But its "I've passed this to the owner" line never arrived: that turn returned `reply: null, thread_id: null`. Every message after it returned `{"agent_invoked": false, "reason": "no_reply"}`, so from the customer's side the shop just stopped talking. Chord could deliver the agent's last message on the turn that hands over, and say `handed_over` rather than `no_reply`.

- **Uploaded skill shows as "Untitled skill"** despite `name:` in the frontmatter (also reported by the other builder; I saw the same in `GET /v1/teammates/{id}/skills`). I set the name through the Skills API draft save.
- **Tool names are mangled from non-ASCII server names.** "Àṣà Thrift tools" became `mcp______Thrift_tools__find_items` in step traces.
- **A new `session_id` landed on an old thread.** Two `say` calls with the same `sender_id` and different `session_id`s returned the same `thread_id`. The docs say a new session id starts a fresh conversation. I couldn't inspect it (no `thread:read`), so in my CLI I now use one sender per session.
- **Vercel:**
  - *Type definitions.* The builder failed with `TS2688: Cannot find type definition file for 'node'` on TypeScript 7.0.2. I reproduced it with a local `vercel build` and pinned 5.9.
  - *Express mode.* Vercel quietly ran the project in Express mode from `src/app.ts`, which returned 500 on `/` ("Invalid export found"). When I renamed the file, the build demanded an entry that imports express. It now lives at `src/server.ts`.
  - *`.gitignore`.* `vercel link` appended `.env*` to `.gitignore`, which silently re-ignored `.env.example`.
- **Upstash on the Vercel Marketplace** needed the account owner to accept terms in a browser (`integration_terms_acceptance_required`) before the CLI could provision it.

## What I'd build next

- A small owner view of open holds and paid orders, fed by the same Redis store.
- Proactive messages, once Chord lets a webhook-triggered run reply into the customer's chat. A receipt the second `charge.success` lands, and a "your hold ends in 5 minutes" nudge, would remove most "have you seen my money?" messages.
- Splitting the owner's notification out of Paystack's emails into WhatsApp, via Chord's handover once that's reliable from the simulator.
