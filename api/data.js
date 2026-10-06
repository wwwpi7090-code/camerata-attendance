// Camerata Attendance – online storage (Vercel Function + Upstash Redis REST API)
// Needs these Environment Variables in Vercel:
//   APP_PIN                     the choir PIN people type once on each device
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (or KV_REST_API_URL / KV_REST_API_TOKEN)
//   – the Upstash ones are added automatically when you connect Upstash in Vercel.

const URL_  = process.env.UPSTASH_REDIS_REST_URL  || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const PIN   = process.env.APP_PIN;

const META = 'camerata:meta';   // members, extra rehearsals, labels, deleted Mondays (one JSON value)
const ATT  = 'camerata:att';    // hash: field "YYYY-MM-DD|memberId" = "1"  (one field per tick)

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID   = /^[A-Za-z0-9_-]{1,60}$/;

async function redis(commands) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  const out = await r.json();
  out.forEach(x => { if (x.error) throw new Error(x.error); });
  return out.map(x => x.result);
}

function validMeta(m) {
  return m && typeof m === 'object' && Array.isArray(m.members) && JSON.stringify(m).length < 500000;
}
function validTick(f) {
  const [d, id] = String(f).split('|');
  return DATE.test(d) && ID.test(id || '');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN || !PIN) return res.status(500).json({ error: 'not-configured' });
  if (String(req.headers['x-pin'] || '') !== String(PIN)) return res.status(401).json({ error: 'pin' });

  try {
    if (req.method === 'GET') {
      const [meta, att] = await redis([['GET', META], ['HGETALL', ATT]]);
      const ticks = [];
      if (Array.isArray(att)) for (let i = 0; i < att.length; i += 2) ticks.push(att[i]);
      return res.status(200).json({ meta: meta ? JSON.parse(meta) : null, ticks });
    }

    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

      if (b.op === 'tick') {
        const f = `${b.date}|${b.id}`;
        if (!validTick(f)) return res.status(400).json({ error: 'bad-tick' });
        await redis([b.on ? ['HSET', ATT, f, '1'] : ['HDEL', ATT, f]]);
        return res.status(200).json({ ok: true });
      }

      if (b.op === 'meta') {
        if (!validMeta(b.meta)) return res.status(400).json({ error: 'bad-meta' });
        await redis([['SET', META, JSON.stringify(b.meta)]]);
        return res.status(200).json({ ok: true });
      }

      if (b.op === 'import') {
        if (!validMeta(b.meta) || !Array.isArray(b.ticks) || !b.ticks.every(validTick))
          return res.status(400).json({ error: 'bad-import' });
        const cmds = [['SET', META, JSON.stringify(b.meta)], ['DEL', ATT]];
        if (b.ticks.length) cmds.push(['HSET', ATT, ...b.ticks.flatMap(f => [f, '1'])]);
        await redis(cmds);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'bad-op' });
    }

    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'storage', detail: String(e.message || e) });
  }
};
