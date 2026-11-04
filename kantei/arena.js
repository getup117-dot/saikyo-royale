/*
  みんなの闘技場（ユーザーが作ったキャラの共有）

  保存先：Cloudflare D1（データベース名 saikyo-arena。初回デプロイで自動作成）
  公開前のチェック：OpenAI のモデレーション（絵と文字）＋ 電話番号・メール・URL の除外
  通報が3人分たまったキャラは、自動で非公開になる

  GET  /arena/list        公開中のキャラ一覧（絵なし・戦績つき）
  GET  /arena/img/:id     キャラの絵（data URL）
  POST /arena/upload      キャラを公開する
  POST /arena/result      試合結果を記録する
  POST /arena/report      通報する
  POST /arena/delete      自分が公開したキャラを取り下げる
*/

const MAX_IMG = 400_000; // data URL の長さ（約300KB）
const MAX_PER_OWNER = 30;
const REPORT_LIMIT = 3;

let ready = false;
async function db(env) {
  if (!env.DB) throw new Error('no db');
  if (!ready) {
    await env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS chars (id TEXT PRIMARY KEY, owner TEXT, author TEXT, data TEXT, img TEXT, w INTEGER DEFAULT 0, l INTEGER DEFAULT 0, d INTEGER DEFAULT 0, reports INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, created INTEGER)'
      ),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS reports (cid TEXT, who TEXT, PRIMARY KEY (cid, who))'),
    ]);
    ready = true;
  }
  return env.DB;
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('saikyo:' + s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const clip = (v, n) => String(v ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const STAT_KEYS = ['a', 'd', 'h', 's'];

function cleanChar(c) {
  c = c || {};
  const stats = {};
  for (const k of STAT_KEYS) {
    const v = +((c.stats || {})[k]);
    if (!Number.isInteger(v) || v < 10 || v > 50 || v % 10) return null;
    stats[k] = v;
  }
  if (stats.a + stats.d + stats.h + stats.s !== 120) return null;
  const hands = {};
  for (const k of ['R', 'S', 'P']) {
    const v = +((c.hands || {})[k] || 0);
    if (!Number.isInteger(v) || v < -20 || v > 20 || v % 10) return null;
    hands[k] = v;
  }
  if (hands.R + hands.S + hands.P !== 0) return null;
  const name = clip(c.name, 12);
  const special = clip(c.special, 16);
  if (!name || !special) return null;
  const feats = (Array.isArray(c.feats) ? c.feats : [])
    .filter((f) => f && STAT_KEYS.includes(f.stat) && clip(f.name, 12))
    .slice(0, 3)
    .map((f) => ({ name: clip(f.name, 12), stat: f.stat }));
  return {
    name, special,
    desc: clip(c.desc, 30), bio: clip(c.bio, 60), alias: clip(c.alias, 14), style: clip(c.style, 10),
    comment: clip(c.comment, 40), handNote: clip(c.handNote, 24),
    feats, stats, hands,
    winLines: (Array.isArray(c.winLines) ? c.winLines : []).map((x) => clip(x, 36)).filter(Boolean).slice(0, 3),
  };
}

function personalInfo(text) {
  return /https?:|www\.|\.(com|jp|net)\b/i.test(text) || /@/.test(text) || /\d[\d\-\s]{8,}\d/.test(text);
}

async function moderate(env, text, img) {
  if (env.ARENA_SKIP_MODERATION === '1') return { ok: true }; // ローカルテスト用（本番では設定しない）
  if (!env.OPENAI_API_KEY) return { ok: false, reason: 'server' };
  let r;
  try {
    r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: [{ type: 'text', text: text || '（なし）' }, { type: 'image_url', image_url: { url: img } }],
      }),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!r.ok) return { ok: false, reason: 'moderation_error' };
  const j = await r.json();
  const res = (j.results || [])[0] || {};
  return res.flagged ? { ok: false, reason: 'flagged' } : { ok: true };
}

export async function handleArena(request, env, reply, path) {
  let D;
  try { D = await db(env); } catch { return reply({ error: 'arena not ready' }, 503); }

  if (request.method === 'GET' && path === '/arena/list') {
    const { results } = await D.prepare(
      'SELECT id, author, data, w, l, d, created FROM chars WHERE hidden = 0 AND reports < ? ORDER BY w DESC, created DESC LIMIT 500'
    ).bind(REPORT_LIMIT).all();
    const chars = (results || []).map((r) => {
      let data = {};
      try { data = JSON.parse(r.data); } catch {}
      return { id: r.id, author: r.author, w: r.w, l: r.l, d: r.d, created: r.created, ...data };
    });
    return reply({ chars });
  }

  const m = path.match(/^\/arena\/img\/([a-z0-9]{6,32})$/);
  if (request.method === 'GET' && m) {
    const row = await D.prepare('SELECT img FROM chars WHERE id = ? AND hidden = 0 AND reports < ?').bind(m[1], REPORT_LIMIT).first();
    if (!row) return reply({ error: 'not found' }, 404);
    return reply({ img: row.img });
  }

  if (request.method !== 'POST') return reply({ error: 'not found' }, 404);
  const raw = await request.text();
  if (raw.length > MAX_IMG + 20_000) return reply({ error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return reply({ error: 'bad json' }, 400); }

  if (path === '/arena/upload') {
    const key = String(body.key || '');
    if (!/^[a-f0-9]{32}$/.test(key)) return reply({ error: 'bad key' }, 400);
    const img = String(body.img || '');
    if (img.length > MAX_IMG || !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)) return reply({ error: 'bad image' }, 400);
    const ch = cleanChar(body.char);
    if (!ch) return reply({ error: 'bad char' }, 400);
    const author = clip(body.author, 12);
    const text = [ch.name, ch.special, ch.desc, ch.bio, ch.alias, ch.style, ch.comment, author, ...ch.winLines, ...ch.feats.map((f) => f.name)].join(' ');
    if (personalInfo(text)) return reply({ error: 'personal', reason: 'personal' }, 422);
    const owner = await sha(key);
    const cnt = await D.prepare('SELECT COUNT(*) AS n FROM chars WHERE owner = ? AND hidden = 0').bind(owner).first();
    if ((cnt && cnt.n) >= MAX_PER_OWNER) return reply({ error: 'limit', reason: 'limit' }, 429);
    const mod = await moderate(env, text, img);
    if (!mod.ok) return reply({ error: 'rejected', reason: mod.reason }, mod.reason === 'flagged' ? 422 : 502);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    await D.prepare('INSERT INTO chars (id, owner, author, data, img, created) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, owner, author, JSON.stringify(ch), img, Date.now()).run();
    return reply({ id });
  }

  if (path === '/arena/result') {
    const list = (Array.isArray(body.results) ? body.results : [body]).slice(0, 2);
    const stmts = [];
    for (const r of list) {
      const id = String((r && r.id) || '');
      const col = { w: 'w', l: 'l', d: 'd' }[r && r.r];
      if (!/^[a-z0-9]{6,32}$/.test(id) || !col) continue;
      stmts.push(D.prepare(`UPDATE chars SET ${col} = ${col} + 1 WHERE id = ? AND hidden = 0`).bind(id));
    }
    if (stmts.length) await D.batch(stmts);
    return reply({ ok: true });
  }

  if (path === '/arena/report') {
    const id = String(body.id || '');
    const key = String(body.key || '');
    if (!/^[a-z0-9]{6,32}$/.test(id) || !/^[a-f0-9]{32}$/.test(key)) return reply({ error: 'bad request' }, 400);
    const who = await sha(key);
    const ins = await D.prepare('INSERT OR IGNORE INTO reports (cid, who) VALUES (?, ?)').bind(id, who).run();
    if (ins.meta && ins.meta.changes) await D.prepare('UPDATE chars SET reports = reports + 1 WHERE id = ?').bind(id).run();
    return reply({ ok: true });
  }

  if (path === '/arena/delete') {
    const id = String(body.id || '');
    const key = String(body.key || '');
    if (!/^[a-z0-9]{6,32}$/.test(id) || !/^[a-f0-9]{32}$/.test(key)) return reply({ error: 'bad request' }, 400);
    const owner = await sha(key);
    await D.prepare('UPDATE chars SET hidden = 1 WHERE id = ? AND owner = ?').bind(id, owner).run();
    return reply({ ok: true });
  }

  return reply({ error: 'not found' }, 404);
}
