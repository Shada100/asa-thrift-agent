// small helpers for the bits of Chord setup that only exist in the API
//   npm run chord -- teammates
//   npm run chord -- raw /v1/teammates/<id>
//   npm run chord -- pin <teammateId> <mcpServerId>   (the app can't do this, only the API)
//   npm run chord -- say "is the jacket available?" [sessionId]
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
} else if (cmd === 'pin') {
  const [, teammate, server] = process.argv.slice(2);
  if (!teammate || !server?.startsWith('mcp-')) throw new Error('usage: pin <teammateId> <mcp-...>');
  await chord('PUT', `/v1/teammates/${teammate}`, { set_mcp_server_ids: [server] });
  // read it back, the docs say not to trust the write
  const t = await chord('GET', `/v1/teammates/${teammate}`);
  console.log(`${t.display_name}: mcp_server_ids = ${JSON.stringify(t.mcp_server_ids ?? null)}`);
} else if (cmd === 'say') {
  const [, text, session] = process.argv.slice(2);
  const workspace = process.env.CHORD_WORKSPACE_ID;
  const teammate = process.env.CHORD_TEAMMATE_ID;
  if (!workspace || !text) throw new Error('need CHORD_WORKSPACE_ID in .env and some text');
  const sessionId = session ?? crypto.randomUUID();
  const out = await chord('POST', '/v1/external-chat/messages', {
    workspace_id: workspace,
    ...(teammate ? { teammate_id: teammate } : {}),
    sender_id: 'cli-tester',
    display_name: 'CLI tester',
    session_id: sessionId,
    text,
  });
  for (const step of out.steps ?? []) {
    console.log(`  step: ${step.title ?? step.tool_name} ${step.success === false ? 'FAILED' : ''}`.trimEnd());
  }
  console.log(`\n${out.reply}\n\n(session ${sessionId}, thread ${out.thread_id})`);
} else if (cmd === 'raw') {
  // GET anything and dump it, handy while poking at the API
  console.log(JSON.stringify(await chord('GET', process.argv[3]), null, 2));
} else {
  console.log('usage: teammates | pin <teammate> <server> | say <text> [session] | raw <path>');
}
