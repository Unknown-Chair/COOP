// VotV co-op JOIN-CODE relay — public, multi-session, zero-setup for players.
// Host creates a session (gets a code); friends join with the code. Both POST
// their position; the relay fans out to others in the SAME session only.
// Deploy this once to any free host (Render/Railway/Fly/Oracle); bake its URL
// into the mod bridge. Players then need nothing but the code.
'use strict';
const http = require('http');

// Code alphabet: no ambiguous chars (no 0/O/1/I/L). Two 4-char chunks.
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(rng) {
  let s = '';
  for (let i = 0; i < 8; i++) { s += ALPH[Math.floor(rng() * ALPH.length)]; if (i === 3) s += '-'; }
  return s;
}

function createRelay(opts = {}) {
  const port = opts.port || 7777;
  // Deterministic-ish RNG injected for tests (Math.random is fine in production).
  const rng = opts.rng || Math.random;
  // A player whose bridge stops POSTing for this long is treated as gone, so it
  // can't linger as a frozen phantom avatar or hydrate late joiners. Bridges
  // POST every ~80ms, so 12s tolerates real network hiccups without dropping live players.
  const playerTtl = opts.playerTtlMs || 12000;
  // Optional friends-only gate: if a key is configured (RELAY_KEY env on the host),
  // every POST must present it via the x-relay-key header. Strangers without the
  // key (which ships only inside the mod build you give friends) are rejected and
  // can't even create a session. /health stays open (Render's checks need it).
  const requiredKey = (function resolveKey() {
    if (opts.key) return opts.key;
    if (process.env.RELAY_KEY && process.env.RELAY_KEY.trim()) return process.env.RELAY_KEY.trim();
    // also accept a Render "Secret File" named RELAY_KEY (file on disk, not an env var)
    const fs = require('fs');
    for (const p of ['/etc/secrets/RELAY_KEY', './RELAY_KEY', require('path').join(process.cwd(), 'RELAY_KEY')]) {
      try { const s = fs.readFileSync(p, 'utf8').trim(); if (s) return s; } catch (_) {}
    }
    return null;
  })();
  const sessions = new Map(); // code -> { players: Map<netID,{queue:[],last:Map,lastSeen}>, touched }
  let seq = 0;

  function now() { return opts.clock ? opts.clock() : Date.now(); }

  function newSession() {
    let code;
    do { code = makeCode(rng); } while (sessions.has(code));
    sessions.set(code, { players: new Map(), touched: now() });
    return code;
  }

  function addPlayer(code, netID, name) {
    const s = sessions.get(code); if (!s) return null;
    s.players.set(netID, { name: name || 'player', queue: [], last: new Map(), lastSeen: now() });
    s.touched = now();
    return s;
  }

  function fanout(code, senderId, msg) {
    const s = sessions.get(code); if (!s) return;
    s.touched = now();
    // cache last position per sender so a late joiner is hydrated
    const p = s.players.get(senderId);
    if (p && msg.type === 'POS') p.lastPos = msg;
    for (const [id, pl] of s.players) if (id !== senderId) pl.queue.push(msg);
  }

  function snapshot(code, forId) {
    const s = sessions.get(code); if (!s) return [];
    const out = [];
    for (const [id, pl] of s.players) if (id !== forId && pl.lastPos) out.push(pl.lastPos);
    return out;
  }

  function drain(code, netID) {
    const s = sessions.get(code); if (!s) return [];
    const p = s.players.get(netID); if (!p) return [];
    const q = p.queue; p.queue = []; return q;
  }

  // reap idle sessions
  function reap() {
    const cutoff = now() - (opts.ttlMs || 10 * 60 * 1000);
    for (const [code, s] of sessions) if (s.touched < cutoff) sessions.delete(code);
  }

  const server = http.createServer((req, res) => {
    const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url.startsWith('/health')) return send(200, { ok: true, sessions: sessions.size, keyed: !!requiredKey });
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    if (requiredKey && req.headers['x-relay-key'] !== requiredKey) return send(403, { error: 'unauthorized' });
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let m = {}; try { m = JSON.parse(body || '{}'); } catch (_) { return send(400, { error: 'bad json' }); }
      reap();
      if (req.url.startsWith('/host')) {
        const code = newSession();
        const netID = 'p' + (++seq);
        addPlayer(code, netID, m.name);
        return send(200, { code, netID });
      }
      if (req.url.startsWith('/join')) {
        const code = (m.code || '').toUpperCase().trim();
        if (!sessions.has(code)) return send(404, { error: 'no such session' });
        const netID = 'p' + (++seq);
        addPlayer(code, netID, m.name);
        const peers = [...sessions.get(code).players.keys()].filter(i => i !== netID);
        return send(200, { code, netID, peers });
      }
      if (req.url.startsWith('/msg')) {
        const code = (m.code || '').toUpperCase().trim();
        const s = sessions.get(code);
        if (!s) return send(404, { error: 'session gone' });
        // heartbeat the sender, then drop players whose bridge went silent (dead/
        // disconnected) so they don't linger as frozen phantoms or hydrate joiners.
        const sender = s.players.get(m.netID);
        if (sender) sender.lastSeen = now();
        for (const [id, pl] of s.players) if (now() - (pl.lastSeen || 0) > playerTtl) s.players.delete(id);
        if (m.netID && m.type) fanout(code, m.netID, m);
        const pending = drain(code, m.netID).concat(snapshot(code, m.netID));
        return send(200, pending);
      }
      send(404, { error: 'unknown route' });
    });
  });

  return {
    server,
    listen: (cb) => server.listen(port, cb),
    close: (cb) => server.close(cb),
    _internal: { sessions },
  };
}

module.exports = { createRelay, makeCode };
if (require.main === module) {
  const port = process.env.PORT ? +process.env.PORT : 7777;
  createRelay({ port }).listen(() => console.log('[coderelay] VotV join-code relay on :' + port));
}
