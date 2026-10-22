// one-off probe for Pay with Transfer in test mode. prints raw Paystack JSON.
//   npm run spike -- charge 1000 [email]
//   npm run spike -- verify <ref>
//   npm run spike -- get <path>        e.g. get /transaction?perPage=5
const key = process.env.PAYSTACK_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_')) throw new Error('test key only');

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
}

const [cmd, arg, arg2] = process.argv.slice(2);

if (cmd === 'charge') {
  const reference = `SPIKE-${Date.now().toString(36).toUpperCase()}`;
  const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  await call('POST', '/charge', {
    email: arg2 ?? `${reference.toLowerCase()}@example.com`,
    amount: String(Number(arg ?? 1000) * 100),
    reference,
    bank_transfer: { account_expires_at: expires },
    metadata: { spike: true },
  });
} else if (cmd === 'verify') {
  await call('GET', `/transaction/verify/${encodeURIComponent(arg)}`);
} else if (cmd === 'get') {
  await call('GET', arg);
} else {
  console.log('usage: charge <naira> [email] | verify <ref> | get <path>');
}
