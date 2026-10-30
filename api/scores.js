// Mishel Slayer leaderboard.
// GET  /api/scores?board=alltime            -> top 10
// GET  /api/scores?board=daily&day=YYYY-MM-DD
// POST /api/scores { name, score, board, day }
// Needs an Upstash Redis database connected to the Vercel project (Storage tab).
// Finds the Upstash REST credentials whatever prefix Vercel gave them (KV_, STORAGE_, UPSTASH_REDIS_, ...).
function findEnv(suffix) {
  const env = process.env;
  for (const k of ['KV_' + suffix, 'UPSTASH_REDIS_' + suffix, 'STORAGE_' + suffix, 'STORAGE_KV_' + suffix]) if (env[k]) return env[k];
  const hit = Object.keys(env).find(k => k.endsWith('_' + suffix) && !k.includes('READ_ONLY') && env[k]);
  return hit ? env[hit] : undefined;
}
const DB_URL = findEnv('REST_API_URL') || findEnv('REST_URL');
const DB_TOKEN = findEnv('REST_API_TOKEN') || findEnv('REST_TOKEN');

async function redis(cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

function keyFor(board, day) {
  if (board === 'daily') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
    const diff = Math.abs(Date.parse(day + 'T00:00:00Z') - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'));
    if (!(diff <= 86400000)) return null;
    return 'mishel-slayer:daily:' + day;
  }
  return 'mishel-slayer:score';
}

async function top10(key) {
  const res = await redis(['ZREVRANGE', key, '0', '9', 'WITHSCORES']);
  const out = [];
  for (let i = 0; i < res.length; i += 2) out.push({ name: res[i], score: Number(res[i + 1]) });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DB_URL || !DB_TOKEN) return res.status(500).json({ error: 'Leaderboard database is not connected yet.' });
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const key = keyFor(q.board, q.day);
      if (!key) return res.status(400).json({ error: 'Unknown board.' });
      return res.status(200).json({ scores: await top10(key) });
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      const key = keyFor(body.board, body.day);
      if (!key) return res.status(400).json({ error: 'Unknown board.' });
      const name = String(body.name || '').toUpperCase().replace(/[^A-Z0-9 _.]/g, '').trim().slice(0, 12);
      const score = Math.round(Number(body.score));
      if (!name) return res.status(400).json({ error: 'Type a name first. Letters and numbers only.' });
      if (!Number.isFinite(score) || score <= 0 || score > 200000) return res.status(400).json({ error: 'That score does not look real.' });
      // GT: an existing name only updates when the new score is higher.
      await redis(['ZADD', key, 'GT', String(score), name]);
      if (body.board === 'daily') await redis(['EXPIRE', key, '259200']);
      const [rank, best] = await Promise.all([redis(['ZREVRANK', key, name]), redis(['ZSCORE', key, name])]);
      return res.status(200).json({ scores: await top10(key), rank: rank === null ? null : rank + 1, best: Number(best) });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Leaderboard hit a snag. Try again.' });
  }
};
