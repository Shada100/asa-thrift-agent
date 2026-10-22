# TSG Labs build exercise: Àṣà Thrift checkout agent

Funmi Shada

**Role:** Forward-deployed Engineering

**The business and the problem.** Àṣà Thrift (made up) is a one-person thrift and vintage shop in Yaba, Lagos. It sells one-of-one pieces on Instagram and WhatsApp, and customers pay by bank transfer because their card usually isn't on them.

The owner can't tell a real transfer from a fake "flash fund" alert without opening the bank app for every sale. A fake alert loses a unique piece for good, and a slow check costs honest sales.

This agent takes the customer from "is it still available?" to a paid sale. It holds the piece and issues a one-off Paystack account number for the exact amount. It confirms payment only from Paystack, never from a screenshot, and only then marks the item sold in the owner's Paystack stock.

**Left out on purpose:** discounts, delivery booking, refunds, card payments, and multi-item orders.

## Links

- **Try it:** the Àṣà Thrift teammate is live on my Chord account. Test-chat link: *in the chord account*
- **Recording (3 min):** *link*
- **Code:** this repo. Start with the [README](README.md)
- **[Deployment field notes](docs/field-notes.md)**
- **[Go-live note for the owner](docs/go-live.md)**
- [Design](docs/design.md)

## A conversation to try in the simulator

1. "abeg is the adire maxi dress still available?"
2. "last price?"
3. "ok I'll take it. Tolu, 0803 123 4567"
4. "I've sent it" before paying. You get *not yet*, with the hold time.
5. Send the wrong amount from Paystack's [demo bank](https://demobank.paystackintegrations.com/), then "I've paid". Paystack bounces it and the agent says so.
6. Send the exact amount, then "sent". You get a confirmed sale, and the item's quantity in Paystack stays at 0.
