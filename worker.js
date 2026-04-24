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
  '69e735df467cdd26ec56a830', // Girls: HS Monument vs Northern Cape HS    - 08:30
  '69e92618e8b52c99177d9d58', // Boys:  HS Monument vs Kimberley Boys HS   - 07:30
  // Rugby — Sat 25 Apr
  '69e5d7e6d3d01762105efacc', // U15:   HS Monument vs Durban HS           - 07:55
];

const ULTIMATERUGBY_URL = 'https://www.ultimaterugby.com/wildeklawer-rugby/matches';
const WK_RUGBY_VENUES = ['diamantveld', 'kbh', 'laerskool staats', 'alternatiewe', 'spu'];

const MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

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
          if (!sport) continue;
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

/* ── Ultimaterugby scraper (rugby fallback) ─────────────────────────
 * Parses the public /wildeklawer-rugby/matches page into a list of
 * rugby fixtures with team names, date, time, venue, and (when played)
 * score. No auth or API key needed.
 *
 * Per-match block shape in the HTML:
 *   <div class="match-item">
 *     <a href="/match/{slug}/{id}">{Team1} Vs {Team2} at {Venue} {NNth} {Mon} {YYYY}</a>
 *     <div class="team-home">...<span class="team-name">T1</span>...</div>
 *     <div class="status">
 *       <span class="time">HH:MM</span>   (future)  OR
 *       <span class="score">X</span><span class="score">Y</span>  (played)
 *     </div>
 *     <div class="team-away">...<span class="team-name">T2</span>...</div>
 *   </div>
 */
function inferAgeFromRugbyMatch(venue, team1, team2) {
  // 1) team-name suffix wins (o/14, u15, "U/16" etc.)
  const combined = (team1 + ' ' + team2).toLowerCase();
  const m = combined.match(/\b[ou][\s\/]*(?:nder\s*)?(14|15|16|19)\b/);
  if (m) return 'u' + m[1];
  // 2) venue defaults — A Veld at Diamantveld = U19 festival main field
  const v = (venue || '').toLowerCase();
  if (v.includes('a veld')) return 'u19';
  // 3) unknown
  return null;
}
function parseUltimateRugbyDate(title) {
  // e.g. "... at Diamantveld A Veld 24th Apr 2026"
  const m = title.match(/\s+(\d{1,2})(?:st|nd|rd|th)\s+([A-Z][a-z]{2})\s+(\d{4})\s*$/);
  if (!m) return null;
  const [, day, mon, yr] = m;
  const mm = MONTHS[mon];
  if (!mm) return null;
  return `${yr}-${String(mm).padStart(2,'0')}-${day.padStart(2,'0')}`;
}
function parseUltimateRugbyVenue(title) {
  // extract venue between " at " and trailing date
  const m = title.match(/\s+at\s+(.+?)\s+\d{1,2}(?:st|nd|rd|th)\s+[A-Z][a-z]{2}\s+\d{4}\s*$/);
  return m ? m[1].trim() : '';
}

async function handleRugbyExternal() {
  try {
    const resp = await fetch(ULTIMATERUGBY_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (monnas-wildeklawer)' },
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `ultimaterugby returned ${resp.status}`, matches: [] }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }
    const html = await resp.text();

    // Split on match-item divs and parse each one.
    const items = html.split(/<div class="match-item"/).slice(1);
    const matches = [];
    const seenIds = new Set();
    for (const chunk of items) {
      // anchor link + title
      const aMatch = chunk.match(/<a\s+href="(\/match\/[^"]+)"[^>]*>([^<]+)<\/a>/);
      if (!aMatch) continue;
      const href  = aMatch[1];
      const title = aMatch[2].replace(/&amp;/g, '&').replace(/&#39;/g,"'").trim();

      const date = parseUltimateRugbyDate(title);
      const venue = parseUltimateRugbyVenue(title);
      if (!date || !venue) continue;

      // Filter to Wildeklawer venues only
      const vlow = venue.toLowerCase();
      if (!WK_RUGBY_VENUES.some(v => vlow.includes(v))) continue;

      // Parse team-home and team-away display names
      const homeBlock = chunk.match(/class="team-home"[\s\S]*?<span class="team-name">([^<]+)<\/span>/);
      const awayBlock = chunk.match(/class="team-away"[\s\S]*?<span class="team-name">([^<]+)<\/span>/);
      const team1 = (homeBlock ? homeBlock[1] : '').trim();
      const team2 = (awayBlock ? awayBlock[1] : '').trim();
      if (!team1 || !team2) continue;

      // Status: kickoff time or played score
      let kickoff = null, score1 = null, score2 = null, isPlayed = false;
      // time span can wrap an <i> icon, so match against loose inner content
      const timeMatch = chunk.match(/<span class="time">[\s\S]*?(\d{1,2}:\d{2})[\s\S]*?<\/span>/);
      if (timeMatch) kickoff = timeMatch[1];
      const scoreMatches = [...chunk.matchAll(/<span[^>]*class="[^"]*score[^"]*"[^>]*>\s*(\d+)\s*<\/span>/g)];
      if (scoreMatches.length >= 2) {
        score1 = Number(scoreMatches[0][1]);
        score2 = Number(scoreMatches[1][1]);
        isPlayed = true;
      }

      const idMatch = href.match(/\/(\d+)\s*$/);
      const externalId = idMatch ? Number(idMatch[1]) : null;
      if (externalId && seenIds.has(externalId)) continue; // dedupe: page lists each match in both Fixtures and Results panes
      if (externalId) seenIds.add(externalId);
      const matchDateTime = kickoff ? `${date}T${kickoff}:00+02:00` : `${date}T00:00:00+02:00`;

      matches.push({
        source: 'ultimaterugby',
        id: externalId,
        matchDateTime,
        date,
        kickoff: kickoff || null,
        team1Name: team1,
        team2Name: team2,
        team1Id: null,
        team2Id: null,
        team1GoalsFor: score1,
        team2GoalsFor: score2,
        locationDisplay: venue,
        age: inferAgeFromRugbyMatch(venue, team1, team2),
        played: isPlayed,
        externalUrl: 'https://www.ultimaterugby.com' + href,
      });
    }

    return new Response(JSON.stringify({ matches, fetchedAt: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'External fetch failed', matches: [] }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/tournament')     return handleTournament(url);
    if (url.pathname === '/api/streams')        return handleStreams();
    if (url.pathname === '/api/rugby-external') return handleRugbyExternal();
    return env.ASSETS.fetch(request);
  },
};
