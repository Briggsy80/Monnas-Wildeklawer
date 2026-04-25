const SPORTIVO_API = 'https://sportivo.app/v1/generic/public/api_iframe_tournament_details';

const TOURNAMENTS = {
  'hockey-girls': 7094, // ABSA Wildeklawer Hockey Girls U19 2026
  'hockey-boys':  7095, // ABSA Wildeklawer Hockey Boys  U19 2026
  'netball-u16':  7180, // ABSA Wildeklawer Netball U16  (Female)
  'netball-u19':  7178, // ABSA Wildeklawer Netball U19  (Female)
  'rugby-u14':    7174, // ABSA Wildeklawer Rugby   U14  (Male)
  'rugby-u15':    7173, // ABSA Wildeklawer Rugby   U15  (Male)
  'rugby-u16':    7170, // ABSA Wildeklawer Rugby   U16  (Male)
  'rugby-u19':    7169, // ABSA Wildeklawer Rugby   U19  (Male)
};

const PIXELLOT_API = 'https://supersportschools.watch.pixellot.tv/api/event/list';
const PIXELLOT_EVENT_API = 'https://supersportschools.watch.pixellot.tv/api/event/get_by_id/id/';
const PIXELLOT_PROJECT = '606dace04cf99f438737e283';
const TOURNAMENT_SUBCATEGORY = '69b0f73fc3b2da2375c41437'; // ABSA Wildeklawer Sports Festival 2026

// Events that drop off the Pixellot list API but remain fetchable by ID.
// Add an event here when a known fixture's stream was previously visible
// and has disappeared from /api/streams. Cheap to leave: each pinned ID
// costs one extra GET on the streams refresh (5-min cache at the edge).
const PINNED_EVENT_IDS = [
  // Hockey — Sat 25 Apr
  '69e735df467cdd26ec56a830', // Girls: HS Durbanville vs HS Sentraal       - 09:00 (slot was Monument vs Northern Cape; SSS repurposed the ID once Monument went off air)
  '69e92618e8b52c99177d9d58', // Boys:  HS Monument vs Kimberley Boys HS    - 07:30
];

/* Stream scraping is hockey-only.
 *
 * Per Matomo for week of 19–25 Apr 2026, stream-button clicks were
 * 96% hockey, 2% netball, 1% rugby (5 non-hockey clicks total). Caching
 * non-hockey events via KV was burning ~40% of read budget for
 * effectively zero engagement, so handleStreams + kvRehydrateMissing
 * filter to hockey only. Rugby/netball fixtures still render from
 * Sportivo; they just don't get stream buttons. */
const STREAM_SPORTS = new Set(['hockey']);

function inferSport(title) {
  const t = (title || '').toUpperCase();
  if (t.includes('HOCKEY'))  return 'hockey';
  if (t.includes('NETBALL')) return 'netball';
  if (t.includes('RUGBY'))   return 'rugby';
  return null;
}
function inferGender(title) {
  const t = (title || '').toUpperCase();
  if (t.includes('GIRLS')) return 'girls';
  if (t.includes('BOYS'))  return 'boys';
  return null;
}
function inferAge(title) {
  const m = (title || '').match(/U\s*(14|15|16|19)/i);
  return m ? 'u' + m[1] : null;
}

async function handleTournament(url) {
  const idParam = url.searchParams.get('id') || 'hockey-girls';
  const tournamentId = TOURNAMENTS[idParam];
  if (!tournamentId) {
    return new Response(JSON.stringify({ error: 'Unknown tournament id' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const resp = await fetch(SPORTIVO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://sportivo.app' },
      body: JSON.stringify({ tournamentId }),
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Sportivo returned ${resp.status}` }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await resp.text();
    return new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Tournament fetch failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

/* Shape a Pixellot event object into the frontend's stream shape. */
function shapeEvent(e, fallbackStatus) {
  const sport = inferSport(e.title);
  if (!sport) return null;
  const homeTeam = e.eventTeams?.homeTeam || {};
  const awayTeam = e.eventTeams?.awayTeam || {};
  const id = e._id || e.event_id;
  if (!id) return null;
  return {
    id,
    title: e.title || '',
    sport,
    gender: inferGender(e.title),
    age:    inferAge(e.title),
    home: homeTeam.name || '',
    away: awayTeam.name || '',
    homeId: homeTeam.teamId || homeTeam.id || '',
    awayId: awayTeam.teamId || awayTeam.id || '',
    homeLogo: homeTeam.logo || '',
    awayLogo: awayTeam.logo || '',
    status: e.status || fallbackStatus || 'archived',
    date: e.event_date || 0,
    url: `https://live.supersportschools.com/events/${id}/`,
  };
}

/* KV-backed auto-pinning.
 *
 * Pixellot's list API only exposes a rolling window of ~20 upcoming + 20
 * archived + live events, and ignores the offset parameter. Anything
 * outside that window is invisible.
 *
 * When the EVENT_CACHE KV namespace is bound, every event we ever see
 * gets remembered: its shaped data is cached (6h TTL) and its id is
 * added to a persistent index. On each refresh, events in the index but
 * missing from the current list response are served from the cache (or
 * re-fetched from Pixellot by id if the cache has expired). Result:
 * once a stream has been visible to the worker even once, it stays
 * accessible for the remainder of the tournament.
 *
 * The code is a no-op when the binding is absent, so this is safe to
 * deploy before you've created the KV namespace.
 */
const KV_INDEX_KEY = 'events:index';
const KV_EVENT_TTL = 6 * 3600; // seconds

async function kvRemember(env, events) {
  if (!env?.EVENT_CACHE) return;
  const kv = env.EVENT_CACHE;
  let index = [];
  try { index = (await kv.get(KV_INDEX_KEY, 'json')) || []; } catch (e) {}
  const indexSet = new Set(index);
  let indexChanged = false;
  for (const e of events) {
    if (!indexSet.has(e.id)) { indexSet.add(e.id); indexChanged = true; }
  }
  // Cache every live/current event's shaped data (cheap individual writes).
  // Skip writing if the event is already cached with the same status — keeps
  // within KV write limits on the free tier.
  await Promise.all(events.map(async e => {
    try {
      const existing = await kv.get('events:' + e.id, 'json');
      if (existing && existing.status === e.status && existing.date === e.date) return;
      await kv.put('events:' + e.id, JSON.stringify(e), { expirationTtl: KV_EVENT_TTL });
    } catch (err) { /* swallow individual KV errors */ }
  }));
  if (indexChanged) {
    try { await kv.put(KV_INDEX_KEY, JSON.stringify([...indexSet])); } catch (e) {}
  }
}

async function kvRehydrateMissing(env, alreadySeen) {
  if (!env?.EVENT_CACHE) return [];
  const kv = env.EVENT_CACHE;
  let index = [];
  try { index = (await kv.get(KV_INDEX_KEY, 'json')) || []; } catch (e) {}
  const missing = index.filter(id => !alreadySeen.has(id));
  const rehydrated = [];
  const prune = new Set(); // non-tracked-sport ids — drop from index
  for (const id of missing) {
    // First try the cached event data (fast, no upstream call)
    let cached = null;
    try { cached = await kv.get('events:' + id, 'json'); } catch (e) {}
    if (cached) {
      if (STREAM_SPORTS.has(cached.sport)) rehydrated.push(cached);
      else prune.add(id);
      continue;
    }
    // Cache expired — re-fetch from Pixellot by id and re-cache
    try {
      const resp = await fetch(PIXELLOT_EVENT_API + id, {
        headers: { 'x-project-id': PIXELLOT_PROJECT },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const shaped = shapeEvent(data?.content || {}, 'archived');
      if (!shaped) continue;
      if (!STREAM_SPORTS.has(shaped.sport)) { prune.add(id); continue; }
      rehydrated.push(shaped);
      try { await kv.put('events:' + id, JSON.stringify(shaped), { expirationTtl: KV_EVENT_TTL }); } catch (e) {}
    } catch (err) { /* skip individual failures */ }
  }
  if (prune.size) {
    const cleaned = index.filter(id => !prune.has(id));
    try { await kv.put(KV_INDEX_KEY, JSON.stringify(cleaned)); } catch (e) {}
  }
  return rehydrated;
}

async function handleStreams(env) {
  try {
    const events = [];
    for (const status of ['live', 'archived', 'upcoming']) {
      let offset = 0;
      const maxPages = 10;
      for (let page = 0; page < maxPages; page++) {
        let resp;
        try {
          resp = await fetch(PIXELLOT_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-project-id': PIXELLOT_PROJECT },
            body: JSON.stringify({
              filters: { 'identities.id': TOURNAMENT_SUBCATEGORY, status },
              limit: 20, offset,
            }),
          });
        } catch (fetchErr) { break; }
        if (!resp.ok) break;
        const data = await resp.json();
        const total = data?.content?.entryCount || 0;
        const entries = data?.content?.entries || [];
        for (const e of entries) {
          const shaped = shapeEvent(e, status);
          if (shaped && STREAM_SPORTS.has(shaped.sport)) events.push(shaped);
        }
        offset += entries.length;
        if (offset >= total || entries.length === 0) break;
      }
    }

    const seenIds = new Set(events.map(e => e.id));
    for (const eid of PINNED_EVENT_IDS) {
      if (seenIds.has(eid)) continue;
      try {
        const resp = await fetch(PIXELLOT_EVENT_API + eid, {
          headers: { 'x-project-id': PIXELLOT_PROJECT },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const shaped = shapeEvent(data?.content || {}, 'archived');
        if (!shaped || !STREAM_SPORTS.has(shaped.sport)) continue;
        events.push(shaped);
        seenIds.add(shaped.id);
      } catch (err) { /* skip */ }
    }

    // Remember everything we've seen, then rehydrate events that have
    // since dropped off the Pixellot list window (see kvRemember above).
    await kvRemember(env, events);
    const rehydrated = await kvRehydrateMissing(env, seenIds);
    for (const e of rehydrated) {
      if (!seenIds.has(e.id)) { events.push(e); seenIds.add(e.id); }
    }

    return new Response(JSON.stringify({ events }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Stream fetch failed', events: [] }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/tournament') return handleTournament(url);
    if (url.pathname === '/api/streams')    return handleStreams(env);
    return env.ASSETS.fetch(request);
  },

  // Cron-scheduled refresh (configured via triggers.crons in wrangler.jsonc).
  // Runs every 5 min regardless of visitor traffic, so the Pixellot list is
  // scraped and any new event ids get persisted into KV even if no one is
  // on the site. Response is discarded — we only care about the KV writes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleStreams(env));
  },
};
