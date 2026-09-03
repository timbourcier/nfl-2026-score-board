// Server-side proxy for the NFL schedule + scores.
//
// The browser calls /api/schedule?week=N on your own domain, so there is no
// cross-origin request, nothing for an ad blocker to match on, and no CORS
// header to depend on. This function does the ESPN call from Vercel instead
// and hands back a slim payload.
//
// Deploy: put this file at api/schedule.js in the repo root. Vercel picks it
// up automatically, no config needed.

const ABBR_FIX = { WSH: 'WAS', LA: 'LAR', JAC: 'JAX', ARZ: 'ARI' };
const fixAbbr = (a) => {
  const u = String(a || '').toUpperCase();
  return ABBR_FIX[u] || u;
};

function parseEvents(events) {
  const games = [];
  for (const ev of events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const cs = comp.competitors || [];
    const H = cs.find((x) => x.homeAway === 'home');
    const A = cs.find((x) => x.homeAway === 'away');
    if (!H || !A) continue;

    const home = fixAbbr(H.team && H.team.abbreviation);
    const away = fixAbbr(A.team && A.team.abbreviation);
    if (!home || !away) continue;

    const st = ((comp.status || {}).type) || {};
    const as = A.score === undefined || A.score === null ? null : Number(A.score);
    const hs = H.score === undefined || H.score === null ? null : Number(H.score);

    let winner = null;
    if (st.completed && as !== null && hs !== null) {
      if (as > hs) winner = away;
      else if (hs > as) winner = home;
    }

    games.push({
      id: away + '@' + home,
      away,
      home,
      state: st.state || 'pre',
      detail: st.shortDetail || '',
      as,
      hs,
      winner,
    });
  }
  return games;
}

export default async function handler(req, res) {
  const week = Math.min(18, Math.max(1, parseInt(req.query.week, 10) || 1));
  const year = String(req.query.year || '2026').replace(/\D/g, '') || '2026';
  // 2 = regular season, 3 = postseason (week 1 wild card, 2 divisional,
  // 3 conference championships, 5 Super Bowl)
  const type = parseInt(req.query.type, 10) === 3 ? 3 : 2;

  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${year}&seasontype=${type}&week=${week}`,
    `https://cdn.espn.com/core/nfl/schedule?xhr=1&year=${year}&seasontype=${type}&week=${week}`,
  ];

  let lastError = 'no response';

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          accept: 'application/json',
          // ESPN sometimes rejects requests with no user agent
          'user-agent': 'Mozilla/5.0 (compatible; eagles-2026/1.0)',
        },
      });
      if (!r.ok) {
        lastError = 'upstream HTTP ' + r.status;
        continue;
      }
      const j = await r.json();

      let events = j.events;
      // the cdn route nests games under content.schedule keyed by date
      if (!events && j.content && j.content.schedule) {
        events = [];
        for (const day of Object.keys(j.content.schedule)) {
          events = events.concat(j.content.schedule[day].games || []);
        }
      }

      const games = parseEvents(events);
      if (!games.length) {
        lastError = 'no games parsed';
        continue;
      }

      // cache at the edge so repeated loads are cheap and ESPN isn't hammered
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
      return res.status(200).json({ week, type, count: games.length, games });
    } catch (e) {
      lastError = (e && e.message) || String(e);
    }
  }

  return res.status(502).json({ week, type, error: lastError, games: [] });
}
