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

const PINNED_EVENT_IDS = [];

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

async function handleStreams() {
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
          const sport = inferSport(e.title);
          if (!sport) continue; // drop non-hockey/netball/rugby (soccer, other)
          const homeTeam = e.eventTeams?.homeTeam || {};
          const awayTeam = e.eventTeams?.awayTeam || {};
          events.push({
            id: e._id,
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
            status: e.status || status,
            date: e.event_date || 0,
            url: `https://live.supersportschools.com/events/${e._id}/`,
          });
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
        const e = data?.content;
        if (!e) continue;
        const sport = inferSport(e.title);
        if (!sport) continue;
        events.push({
          id: e._id || e.event_id || eid,
          title: e.title || '',
          sport,
          gender: inferGender(e.title),
          age:    inferAge(e.title),
          home: e.eventTeams?.homeTeam?.name || '',
          away: e.eventTeams?.awayTeam?.name || '',
          status: e.status || 'archived',
          date: e.event_date || 0,
          url: `https://live.supersportschools.com/events/${eid}/`,
        });
      } catch (err) { /* skip */ }
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
    if (url.pathname === '/api/streams')    return handleStreams();
    return env.ASSETS.fetch(request);
  },
};
