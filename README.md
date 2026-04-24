# Monnas Wildeklawer

Community fixtures-and-scores tracker for the ABSA Wildeklawer Sports Festival 2026, built for the Monument ("Monnas") community. Hosts live on [wildeklawer.cylon.biz](https://wildeklawer.cylon.biz).

Covers the eight Wildeklawer tournaments:

| Sport | Variants |
|---|---|
| Hockey | Girls U19, Boys U19 |
| Netball | U16, U19 |
| Rugby | U14, U15, U16, U19 |

## Features

- **Live fixtures, scores, standings** pulled from the organisers' Sportivo portal. Polled every 60 s; scores appear on fixture rows the moment Sportivo publishes them.
- **Stream links** from SuperSport Schools (Pixellot) — live / replay / upcoming pills inline on each fixture, matched to the fixture by normalised team name + date + sport/gender/age.
- **Rugby live fallback** — when Sportivo has no rugby fixtures, matches are sourced from [ultimaterugby.com/wildeklawer-rugby](https://www.ultimaterugby.com/wildeklawer-rugby). Includes live scores, a "Match Centre" out-link, and age/venue badges. Sportivo overrides per-match by team-name + date when it catches up.
- **Hockey Day 2 and Day 3 pre-populated** from the organisers' published schedule (positional placeholders like "4th Group 1 vs 4th Group 2"). Used only on dates where Sportivo has no matches; superseded automatically when Sportivo publishes the draw.
- **Follow teams** — star any team in the Info tab. Selection persists per tournament (localStorage), with Monument / Monnas auto-followed on first visit where the school is entered. Followed teams are gold-highlighted across fixtures, pools, and bracket.
- **Per-sport / per-age persistence** — last-viewed variant is remembered per sport, so jumping between Hockey → Rugby → Netball returns you to whichever age group you had open.
- **Auto-collapse past days** — each day is a collapsible block. Today and future days stay open; previous days roll up automatically at local (SAST) midnight.
- **Auto-scroll to next fixtures** — the viewport centres on the next four upcoming fixtures on each render, rate-limited to once every 20 minutes.
- **Knockout bracket** tab populates automatically once Sportivo publishes later phases.
- **Resources** — tournament PDFs (playing conditions, etc.) surface in the Info tab.

## Data sources

| Source | Endpoint | Role |
|---|---|---|
| Sportivo | `POST sportivo.app/v1/generic/public/api_iframe_tournament_details` | Primary fixtures, scores, pools, teams, resources |
| Pixellot (SuperSport Schools) | `POST supersportschools.watch.pixellot.tv/api/event/list` | Stream URLs, tagged with sport/gender/age from title |
| ultimaterugby.com | `GET /wildeklawer-rugby/matches` (HTML scrape) | Rugby fixtures + live scores fallback |

All three are proxied through the Cloudflare Worker so the browser only talks to `wildeklawer.cylon.biz`. Responses are cached 30 s (tournament) / 5 min (streams) / 2 min (rugby external) at the edge.

## Architecture

```
wildeklawer.cylon.biz
        │
        ▼
Cloudflare Worker (worker.js) ─── routes ───┐
        │                                   │
        │ GET /           ──▶ static assets ASSETS binding → public/index.html
        │ GET /api/tournament?id=<key>  ──▶ Sportivo
        │ GET /api/streams              ──▶ Pixellot
        │ GET /api/rugby-external       ──▶ ultimaterugby.com
```

Single-file vanilla-JS SPA, no build step. All state lives client-side (localStorage for preferences; nothing stored server-side).

## Local development

```bash
git clone https://github.com/Briggsy80/Monnas-Wildeklawer.git
cd Monnas-Wildeklawer
npx wrangler dev
```

Serves on `http://localhost:8787` with live reload on `worker.js` / `public/*`.

## Deployment

The Worker is configured in `wrangler.jsonc` as a Worker-with-Assets (`name: "monnas-wildeklawer"`). Two deploy routes, either works:

**Via GitHub integration** (default) — pushes to `main` trigger an automatic deploy in the Cloudflare dashboard. Set up in *Workers & Pages → monnas-wildeklawer → Settings → Build*.

**Manual** — from your machine:

```bash
npx wrangler deploy
```

Uses the active Cloudflare login (`npx wrangler login` the first time). Updates the existing Worker rather than creating a new one.

Preview deploys for the `dev` branch can be enabled in *Settings → Build → Branch control*.

## Branches

- `main` — production, deployed to `wildeklawer.cylon.biz`
- `dev` — active development; promoted to main via fast-forward merge or PR

## Analytics

Uses Matomo at `analytics.modernbiz.co.za` (site ID 25). For the sport/age/variant/tab filters to show values in reports, four action-scope custom dimensions need to be created in the Matomo admin panel:

| ID | Name | Values |
|---|---|---|
| 1 | Sport | `hockey` / `netball` / `rugby` |
| 2 | AgeGroup | `u14` / `u15` / `u16` / `u19` |
| 3 | Variant | `hockey-girls`, `netball-u19`, `rugby-u15`, … |
| 4 | Tab | `fixtures` / `pools` / `bracket` / `info` |

Pushes to unconfigured dimension IDs are silently ignored by Matomo, so the site remains safe to deploy before the admin-side dimensions exist — reports just won't split by them until then.

Virtual pageviews fire on initial load and every sport / variant / tab change (URL pattern `/wildeklawer/<sport>/<variant>/<tab>`), so time-on-page is measured correctly per view. Events are tracked for stream clicks, Match Centre clicks, resource opens, and follow / unfollow toggles.

All out-bound links carry `utm_source=monnas-wildeklawer&utm_medium=referral&utm_campaign=absa-wildeklawer-2026`.

## Repo layout

```
.
├── worker.js            Cloudflare Worker — API proxies + asset routing
├── wrangler.jsonc       Deploy configuration
├── public/
│   └── index.html       Single-page app (HTML/CSS/JS)
└── README.md
```

No dependencies, no package.json — `wrangler` is the only tool and runs via `npx`.
