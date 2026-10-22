# Going live: a note for the owner of Àṣà Thrift

**What it does.** It answers customers on WhatsApp with live stock and prices from your Paystack product list. It holds a piece for 30 minutes and gives the customer an account number for that order and the exact amount. It says "payment received" only when Paystack confirms the money landed, so fake alerts and screenshots can't fool it. Sold pieces drop out of your Paystack stock, with the buyer's name and phone on the transaction.

**What it doesn't do.** Bargain (persistent hagglers come to you), book delivery, refund, take cards, or sell more than one item per order. Complaints and anything it's unsure about are handed to you.

**Before real customers**
1. Paystack approves Àṣà Thrift as a registered business with Pay with Transfer, and I swap in the live key. It refuses live keys today, on purpose.
2. A real WhatsApp number is connected to the teammate in Chord.
3. Paystack transaction alerts go to your phone. That's how you know what to deliver.
4. Chord's escalation email goes to an inbox you check during shop hours.
5. You update stock in Paystack the moment you sell something in person or in a DM. The agent trusts that number.

**When things go wrong**
- **Paystack down:** the customer is told to try again shortly. Nothing is charged or marked sold.
- **Wrong amount sent:** Paystack returns it to the customer's bank, and the agent asks for the exact amount.
- **Hold runs out:** the piece goes back on sale.
- **Paid after the piece sold elsewhere:** it's handed to you to refund from the dashboard.
- **Nobody is alerted automatically if the tool server stops.** I'll add a phone alert before launch.

**First week:** run it on Chord's "Work with me" setting so you see every reply, then switch to "Act independently".
