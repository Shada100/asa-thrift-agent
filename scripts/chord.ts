// small helpers for the bits of Chord setup that only exist in the API
//   npm run chord -- teammates
//   npm run chord -- raw /v1/teammates/<id>
const base = process.env.CHORD_BASE_URL ?? 'https://api.chordhq.xyz';
const key = process.env.CHORD_API_KEY;
if (!key) throw new Error('CHORD_API_KEY missing from .env');

async function chord(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    console.error(res.status, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json as any;
}

const [cmd] = process.argv.slice(2);

if (cmd === 'teammates') {
  const out = await chord('GET', '/v1/teammates');
  const list = Array.isArray(out) ? out : out.data ?? out.teammates ?? out.items ?? [];
  for (const t of list) {
    console.log([t.id, t.display_name ?? t.name, t.workspace_id, t.lifecycle_state ?? t.status, JSON.stringify(t.mcp_server_ids ?? null)].join(' | '));
  }
  if (!list.length) console.log(JSON.stringify(out, null, 2).slice(0, 2000));
} else if (cmd === 'raw') {
  // GET anything and dump it, handy while poking at the API
  console.log(JSON.stringify(await chord('GET', process.argv[3]), null, 2));
} else {
  console.log('usage: teammates | raw <path>');
}
