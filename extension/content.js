/*
 * Yahoo sensor.
 *
 * This deliberately does NOT read the draft room. It fetches Yahoo's own
 * server-rendered draft results page, same-origin, from whatever Yahoo tab
 * happens to be open. That means:
 *
 *   - it needs no API approval and no cookie export, because the fetch
 *     inherits the session already in the browser
 *   - it survives Yahoo redesigning the draft room, because a results table is
 *     a far more stable surface than React internals
 *   - it works while you draft from the phone app, as long as one desktop tab
 *     is sitting on any Yahoo fantasy page
 *
 * The match pattern is the whole fantasysports domain rather than a draft-room
 * URL, because matching on URL shape is exactly the failure this design exists
 * to avoid.
 *
 * The POST to localhost goes through the background worker: a page served over
 * HTTPS cannot fetch plain HTTP, but the extension can.
 */

/*
 * Yahoo rate-limits with HTTP 999 and it is unforgiving: a 3s poll got the whole
 * origin blocked, after which the companion showed a stale board while looking
 * healthy. Poll gently and back off hard when refused.
 */
const POLL_MS = 6000
const MAX_BACKOFF_MS = 120000
/*
 * The tick is the resolution, not the request rate. Each league carries its own
 * cadence from the companion — six seconds while a draft runs, three when a
 * pick is close, five minutes otherwise — because polling four leagues every
 * six seconds for ever is 2,400 requests an hour, nearly all of them about
 * drafts that finished weeks ago. That is what earned an HTTP 999 across the
 * whole fantasysports origin, which took the fantasy baseball league with it.
 */
const IDLE_POLL_MS = 300000
/** A fixed interval is a signature; spread each league's next call about. */
const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3))
const nextDue = new Map()

/** Yahoo abbreviates a few positions differently from the app. */
const POS_ALIAS = { DEF: 'DST', D: 'DST' }

function parseDraftResults(doc) {
  const rows = []
  for (const table of doc.querySelectorAll('table')) {
    for (const tr of table.rows) {
      const cells = tr.cells
      if (!cells || cells.length < 3) continue
      const link = cells[1].querySelector('a.name')
      if (!link) continue

      const pickInRound = Number((cells[0].textContent || '').trim().replace('.', ''))
      if (!pickInRound) continue

      const meta = cells[1].querySelector('span')
      const m = /\(([\w.\- ]+)\s*-\s*([A-Z/]+)\)/.exec(meta ? meta.textContent : '')
      const manager = (cells[2].getAttribute('title') || cells[2].textContent || '').trim()

      rows.push({
        pickInRound,
        name: link.textContent.trim(),
        team: m ? m[1].trim().toUpperCase() : '',
        pos: m ? POS_ALIAS[m[2]] || m[2] : '',
        manager,
      })
    }
  }

  // Yahoo renders one table per round, in order, so the round is the table the
  // row came from. Recovered by walking pick numbers rather than table index,
  // which keeps working if the markup nests differently.
  let round = 0
  let last = Infinity
  for (const r of rows) {
    if (r.pickInRound <= last) round++
    last = r.pickInRound
    r.round = round
  }
  return rows
}

/**
 * This week's score, read off your own team page while the games are on.
 *
 * The app could only ever see a score if you happened to be looking at one, so
 * three leagues reported "live · 0.0 so far" all evening against a capture
 * taken before kickoff. Fetched the same way the draft board is: same origin,
 * inheriting the session already in the browser, and only while games are
 * actually running.
 *
 * This is the team page rather than the matchup page on purpose — see
 * parseTeamTotals. It costs no extra request either, since the roster and the
 * score now come out of the one fetch.
 */
async function pollScore(mapping) {
  /*
   * Without a team id there is no team page to read. That id arrives by your
   * visiting the team once, so this is a real state rather than a fault, and
   * it says which.
   */
  if (!mapping.teamId) throw new Error('no team id yet — open your Yahoo team once')
  const res = await fetch(`/f1/${mapping.yahooLeagueId}/${mapping.teamId}`, { credentials: 'include' })
  if (res.status === 999) {
    const err = new Error('Yahoo is rate limiting (HTTP 999) — backing off')
    err.rateLimited = true
    throw err
  }
  if (!res.ok) throw new Error(`team page HTTP ${res.status}`)
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
  const { rows, unread, projCol, ptsCol, sawHeaders, shape, totalPlayerRows } = parseRoster(doc)
  const totals = parseTeamTotals(doc)
  const standing = parseStanding(doc)
  /*
   * Complain rather than return nothing. Returning null on an unreadable page
   * is precisely how the last break stayed invisible: a sensor that says
   * nothing looks identical to one with nothing to say, and it had nothing to
   * say for a whole evening.
   */
  if (!rows.length) {
    throw new Error(`no player rows on /f1/${mapping.yahooLeagueId}/${mapping.teamId}`)
  }
  if (!totals) throw new Error(`no scoreline on /f1/${mapping.yahooLeagueId}/${mapping.teamId}`)
  return {
    type: 'yahooRoster',
    kind: 'team',
    yahooLeagueId: mapping.yahooLeagueId,
    teamId: mapping.teamId,
    players: rows,
    totals, standing, unread, projCol, ptsCol, sawHeaders, shape, totalPlayerRows,
    url: `/f1/${mapping.yahooLeagueId}/${mapping.teamId}`,
  }
}

/**
 * The draft order by team name, from round one of the results page. Before the
 * draft the rows are empty but the managers are listed, which is how the
 * companion learns its seat without being told.
 */
function parseOrder(doc) {
  const table = doc.querySelector('table')
  if (!table) return []
  const order = []
  for (const tr of table.rows) {
    const cells = tr.cells
    if (!cells || cells.length < 3) continue
    if (!Number((cells[0].textContent || '').trim().replace('.', ''))) continue
    order.push((cells[2].getAttribute('title') || cells[2].textContent || '').trim())
  }
  return order
}

async function pollLeague(mapping) {
  // Basketball's page lives at /nba/<id>/draftresults; the companion says where.
  const url = (mapping.sensor && mapping.sensor.path) || `/f1/${mapping.yahooLeagueId}/draftresults`
  const res = await fetch(url, { credentials: 'include' })
  if (res.status === 999) {
    const err = new Error('Yahoo is rate limiting (HTTP 999) — backing off')
    err.rateLimited = true
    throw err
  }
  if (!res.ok) throw new Error(`draftresults HTTP ${res.status}`)
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
  const rows = parseDraftResults(doc)
  const order = mapping.sport === 'nba' ? parseOrder(doc) : undefined
  if (!rows.length) return { leagueId: mapping.leagueId, sport: mapping.sport, order, rows: [], skipped: 'no picks yet' }
  return { leagueId: mapping.leagueId, sport: mapping.sport, order, rows }
}

let mappings = []
let timer = null
let mappingTimer = null
let failures = 0

/**
 * A draft room URL carries everything needed to sense a draft the companion has
 * never heard of: /draftclient/f1/<leagueId>/<teamId>. Reading it means a mock
 * is picked up by opening it, with no id to copy anywhere.
 */
/**
 * Your own team page, which is the one Yahoo URL that needs no guessing.
 *
 * With no API access, roster state has to come from somewhere, and every other
 * route requires knowing your team id in advance — which nothing knows before a
 * draft. Visiting your team is the one moment you hand it over for free, so the
 * sensor takes it then rather than hunting for it.
 *
 *   /f1/<leagueId>/<teamId>
 */
function detectedTeam() {
  /*
   * Yahoo hangs extra segments off a team page — /team, /roster, a week number —
   * and an exact match caught none of them. Anything under /f1/<league>/<team>
   * is the same team page, so the id is taken and the rest ignored.
   *
   * The draft room is excluded: it lives at /draftclient/f1/... and is handled
   * by the pick sensor, which wants the draft rather than the roster.
   */
  /*
   * The roster page itself, and not everything filed beneath it.
   *
   * This accepted any trailing segment, because Yahoo hangs /team and a week
   * number off the team URL and an exact match caught neither. But it also
   * caught /viewwaiver — the confirmation page for a claim, which lists the two
   * players in the transaction and nothing else. Reading that as a roster
   * replaced a thirteen-man team with the two men who had just swapped places,
   * while Yahoo's own totals on the same page still said the side projected a
   * hundred and six.
   *
   * A missed capture is recoverable by opening the team page; a wrong one is
   * not, so the known roster views are named rather than everything else being
   * guessed at.
   */
  const m = /^\/f1\/(\d+)\/(\d+)(?:\/team)?\/?$/.exec(location.pathname)
  if (m) return { yahooLeagueId: m[1], teamId: m[2], kind: 'team' }
  /*
   * The matchup page is deliberately not a capture target any more. It is
   * built in the browser now, so it cannot be fetched, and everything that was
   * once read from it — projections, the score, the opponent's name and total —
   * is on the team page above. Leaving it in would mean maintaining a second
   * parser for a page the sensor can never reach on its own.
   */
  return null
}

/**
 * Players on the page, read off the links Yahoo puts round every name.
 *
 * Deliberately loose: this is scraping, the markup will change, and a parser
 * that insists on one structure fails silently the week it matters. Anything
 * it cannot read is reported rather than dropped, so a broken selector shows up
 * as a complaint instead of an empty roster.
 */
function parseRoster(doc) {
  const rows = []
  const unread = []

  // Player rows first; the column layout is worked out from them afterwards.
  // Every row here is mine. Splitting this by table once lost my bench.
  const trs = []
  for (const tr of doc.querySelectorAll('tr')) {
    const link =
      tr.querySelector('a[href*="/players/"], a[href*="/nfl/players/"]') ??
      tr.querySelector('a[href*="/teams/"]')
    if (!link) continue
    const name = (link.textContent || '').trim()
    if (!name || name.length > 40) continue
    trs.push({ tr, name, link, table: tr.closest('table') })
  }

  /*
   * Which column holds the projection, decided by testing rather than by
   * reading a header. Matching header text alone picked column zero — the
   * word "proj" appeared in the first cell of an unrelated row, and the
   * position column was read as points for every player.
   *
   * A candidate has to parse as a plausible score on most player rows to be
   * accepted, which no label can fake.
   */
  const width = Math.max(0, ...trs.map((x) => x.tr.children.length))
  const headerCells = []
  for (const tr of doc.querySelectorAll('tr')) {
    const cells = [...tr.children].map((c) => (c.textContent || '').trim())
    if (cells.length === width && cells.some((h) => /player|pos|proj|pts/i.test(h))) {
      headerCells.push(...cells)
      break
    }
  }

  /*
   * A heading names the column; the rows are then asked whether it told the
   * truth. Neither alone is enough. Matching the heading by itself once picked
   * column zero, because the word "proj" appeared in the first cell of an
   * unrelated row — and scoring the rows by themselves cannot tell three
   * columns of plausible points apart, which is the failure below.
   */
  const labelledCol = (re) => {
    const i = headerCells.findIndex((h) => re.test(h))
    if (i < 0) return -1
    let seen = 0
    for (const { tr } of trs) {
      const raw = (tr.children[i]?.textContent || '').trim()
      // An en dash is Yahoo for "not yet", and is as much a reading as a
      // number: before kickoff the whole Fan Pts column is dashes.
      if (/^[-\u2012-\u2015]$/.test(raw) || /^\d+(\.\d+)?/.test(raw)) seen++
    }
    return seen >= Math.max(3, trs.length * 0.8) ? i : -1
  }

  /*
   * Points already scored. This is the whole live score, and it was sitting on
   * the team page the entire time: the sensor went to the matchup page for it,
   * which Yahoo has since moved to client rendering, so a fetch there returns
   * a shell with ten rows and no players in it. Three leagues read
   * "live · 0.0 so far" all evening while A.J. Brown's 4.10 was on the page
   * being polled every two minutes.
   */
  const ptsCol = labelledCol(/^fan\s*pts$/i)

  /*
   * A projection carries a decimal point; a bye week does not. Accepting any
   * integer in a plausible range took the bye column — ten for Nix, seven for
   * Cook, thirteen for Henry, all correct byes and all read as points, summing
   * to eighty against Yahoo's ninety-nine.
   */
  let projCol = labelledCol(/^proj\.?\s*pts$/i)
  let bestScore = 0
  const guessing = projCol < 0
  for (let c = 0; guessing && c < width; c++) {
    /*
     * "Proj Max" and "Proj Min" are the ends of Yahoo's range, not its
     * projection, and they beat it on this scoring for a reason that only
     * shows up once the games start: a player in progress has his projection
     * printed twice in the cell, the original and the live revision, so it
     * stops parsing as a bare number while the range columns stay clean.
     * Herbert was being read at 25.90 rather than 19.33, and every kickoff
     * made the inflation worse.
     */
    if (/max|min/i.test(headerCells[c] ?? '') || c === ptsCol) continue
    let numeric = 0
    let decimals = 0
    for (const { tr } of trs) {
      const raw = (tr.children[c]?.textContent || '').trim()
      if (!/^\d+(\.\d+)?$/.test(raw)) continue
      const n = Number.parseFloat(raw)
      if (!Number.isFinite(n) || n < 0 || n >= 80) continue
      numeric++
      if (raw.includes('.')) decimals++
    }
    const enough = numeric >= Math.max(3, trs.length * 0.6)
    // Most values must be fractional, which no week number ever is.
    const fractional = decimals >= numeric * 0.5
    if (!enough || !fractional) continue
    const weight = /proj/i.test(headerCells[c] ?? '') ? 1.5 : 1
    const score = (numeric / Math.max(1, trs.length)) * weight
    if (score > bestScore) { bestScore = score; projCol = c }
  }

  const tables = []
  for (const { table } of trs) if (table && !tables.includes(table)) tables.push(table)

  for (const { tr, name } of trs) {
    const text = (tr.textContent || '').replace(/\s+/g, ' ')
    /*
     * Yahoo writes the club in mixed case — "Dal - QB", "Sea - RB", "Phi - WR"
     * — and only the naturally capitalised ones come out shouting: SF, LAC,
     * LV, NYJ, NO, TB. Insisting on capitals therefore read the club and the
     * position of six players in a sixteen-man squad and dropped both for the
     * other ten, who then had to be resolved on name alone.
     *
     * That is fine until two men share a name. DeVonta Smith the Philadelphia
     * receiver and Devonta Smith the Carolina defensive back differ by one
     * capital letter, so the lookup could not choose between them and refused
     * to guess — correctly. The consequence was a starter missing from the
     * roster, an empty receiver slot, and the board offering ten points off
     * the bench to fill a hole that was never there.
     */
    const posTeam = /\b([A-Za-z]{2,3})\s*-\s*(QB|RB|WR|TE|K|DEF|D\/ST|DB|DL|LB)\b/.exec(text)
    const slot = (tr.querySelector('td')?.textContent || '').trim().slice(0, 6)
    const isDef = /^(DEF|D\/ST|DST|D)$/i.test(slot) || /\bDEF\b/.test(text)
    /*
     * parseFloat rather than a full match, because a player whose game is on
     * has two numbers in this cell — the projection he started with and the
     * one Yahoo has revised down since. The first is the one the lineup was
     * chosen against, so it is the one that belongs beside the bench.
     */
    let projected = null
    if (projCol >= 0) {
      const n = Number.parseFloat((tr.children[projCol]?.textContent || '').trim())
      if (Number.isFinite(n)) projected = n
    }
    /*
     * Null, not nought. Yahoo prints an en dash until a player's game starts,
     * and a zero here would be read as a man who took the field and did
     * nothing — the same mistake in the other direction.
     */
    let points = null
    if (ptsCol >= 0) {
      const n = Number.parseFloat((tr.children[ptsCol]?.textContent || '').trim())
      if (Number.isFinite(n)) points = n
    }
    rows.push({
      name,
      team: posTeam ? posTeam[1].toUpperCase() : null,
      pos: posTeam ? posTeam[2] : isDef ? 'DEF' : null,
      slot,
      projected,
      points,
    })
  }

  /*
   * A shape report, so a page that does not parse can be diagnosed from the log
   * rather than by guessing at markup nobody here can see. Three wrong guesses
   * at the projection column cost five extension reloads; one header dump ended
   * it in a single pass.
   */
  const shape = tables.map((t, i) => ({
    table: i,
    players: trs.filter((x) => x.table === t).length,
    caption: (t.closest('[class*=matchup], section, div')?.querySelector('h1,h2,h3,caption')
      ?.textContent || '').trim().slice(0, 40),
  }))
  return { rows, unread, projCol, ptsCol, sawHeaders: headerCells, shape, totalPlayerRows: trs.length }
}

/*
 * The week's score, both sides, as Yahoo's own arithmetic makes it.
 *
 * The sensor used to read this off the matchup page, which carried two
 * lineups mirrored across a shared slot column. That page is now built in the
 * browser: fetching it same-origin returns a 961KB shell with ten table rows
 * and no player in any of them, so the parser found nothing, pollMatchup
 * returned null, and the whole thing failed without a word. Three leagues
 * showed "live · 0.0 so far" for an entire evening.
 *
 * The team page is still rendered on the server, is the one page that needs no
 * ids guessed at, and is already fetched every cycle — and it turns out to
 * carry the entire matchup in a script block: both totals, both projections,
 * both team names. Yahoo's own numbers, rather than a sum of the rows, so the
 * total on the tile matches the total on the site to the tenth.
 */
function parseTeamTotals(doc) {
  let blob = ''
  for (const s of doc.querySelectorAll('script')) {
    const t = s.textContent || ''
    if (t.includes('varPRCurrTeamWeekScore')) { blob = t; break }
  }
  if (!blob) return null
  // Yahoo quotes some of these and not others — the scores are strings, the
  // projections bare numbers — so the quotes are optional on the way out.
  const read = (key) => {
    const m = new RegExp('"' + key + '"\\s*:\\s*(?:"([^"]*)"|([-\\d.]+))').exec(blob)
    return m ? (m[1] ?? m[2]) : null
  }
  const num = (key) => {
    const v = read(key)
    if (v == null || v === '') return null
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  const totals = {
    teamName: read('varPRCurrTeamName'),
    opponentName: read('varPROppTeamName'),
    mine: num('varPRCurrTeamWeekScore'),
    theirs: num('varPROppTeamWeekScore'),
    projectedMine: num('varPRCurrTeamWeekProjectedPts'),
    projectedTheirs: num('varPROppTeamWeekProjectedPts'),
    /*
     * Where the season stands, from the same block. These read nought until a
     * week has been played, which is why they went unnoticed: on the Sunday
     * the app was built they had nothing to say.
     */
    rank: num('varPRCurrTeamRank'),
    pointsFor: num('varPRCurrTeamOverallScore'),
  }
  // A block with a name but no number in it is not a scoreline.
  return totals.mine == null && totals.theirs == null ? null : totals
}

/**
 * The season record, which Yahoo prints and does not put in the script block.
 *
 * It sits as a bare "1-0-0" next to "4th Place", so the place is what tells a
 * record apart from every other pair of numbers on the page — a score, a time,
 * a date. Without that test this would happily read a scoreline as a record.
 *
 * Points against is not on this page at all, and the standings page that would
 * have it is built in the browser now: fetching it returns nine hundred
 * kilobytes with no table rows in it. That half waits for the API rather than
 * being guessed at.
 */
function parseStanding(doc) {
  for (const el of doc.querySelectorAll('span, div, b, strong, em')) {
    if (el.children.length) continue
    const t = (el.textContent || '').trim()
    if (!/^\d{1,2}-\d{1,2}(-\d{1,2})?$/.test(t)) continue
    const near = ((el.parentElement && el.parentElement.textContent) || '').replace(/\s+/g, ' ')
    const place = /(\d+)(?:st|nd|rd|th)\s*place/i.exec(near)
    if (!place) continue
    const [w, l, d] = t.split('-').map(Number)
    return { wins: w, losses: l, ties: d || 0, place: Number(place[1]) }
  }
  return null
}

function detectedDraft() {
  /*
   * Basketball's draft room address had not been seen when this was written,
   * so it is matched loosely on its own site: a draft-client path carrying a
   * league id, with or without a sport segment. Football keeps its exact match.
   */
  if (location.host.startsWith('basketball.')) {
    const b = /\/draftclient\/(?:[a-z0-9]+\/)?(\d+)(?:\/(\d+))?/.exec(location.pathname)
    return b ? { yahooLeagueId: b[1], teamId: b[2] || null, sport: 'nba', sensor: { path: `/nba/${b[1]}/draftresults` } } : null
  }
  const m = /\/draftclient\/f1\/(\d+)\/(\d+)/.exec(location.pathname)
  return m ? { yahooLeagueId: m[1], teamId: m[2] } : null
}

/** Team count and round count are both readable off the results table. */
function shapeOf(rows) {
  if (!rows.length) return null
  return {
    teams: Math.max(...rows.map((r) => r.pickInRound)),
    rounds: Math.max(...rows.map((r) => r.round)),
  }
}

/**
 * Every message goes through here. Two things bite otherwise: an unchecked
 * runtime.lastError logs an error for any send whose reply never lands, and
 * after the extension is reloaded the old content script keeps running against
 * a dead context, throwing "Extension context invalidated" on every tick.
 */
function send(message) {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        stopAll()
        return resolve(null)
      }
      chrome.runtime.sendMessage(message, (reply) => {
        // Reading it is what marks it handled; an unread lastError is logged.
        if (chrome.runtime.lastError) return resolve(null)
        resolve(reply ?? null)
      })
    } catch {
      stopAll()
      resolve(null)
    }
  })
}

function stopAll() {
  clearInterval(timer)
  clearInterval(mappingTimer)
  timer = null
  mappingTimer = null
}

let backoff = 0

/**
 * Rosters change when you make a move, not minute to minute, so this pushes
 * whatever the page already shows rather than polling for it. Stale-but-real
 * with an honest timestamp beats absent, and beats invented by a mile.
 */
let lastRosterPush = 0
async function captureRoster() {
  const team = detectedTeam()
  if (!team) return
  if (Date.now() - lastRosterPush < 60000) return
  const { rows, unread, projCol, ptsCol, sawHeaders, shape, totalPlayerRows } = parseRoster(document)
  // Say so rather than failing silently: a page with no readable rows is the
  // symptom of Yahoo changing its markup, and silence looks identical to
  // "you never opened the page".
  if (!rows.length && !unread.length) {
    await send({ type: 'error', leagueId: 'yahoo-roster', message:
      `no player rows found on ${location.pathname}` })
    return
  }
  lastRosterPush = Date.now()
  await send({
    type: 'yahooRoster',
    kind: team.kind,
    yahooLeagueId: team.yahooLeagueId,
    teamId: team.teamId,
    players: rows,
    totals: parseTeamTotals(document),
    standing: parseStanding(document),
    unread,
    projCol,
    ptsCol,
    sawHeaders,
    shape,
    totalPlayerRows,
    url: location.href,
  })
}

async function tick() {
  await captureRoster()
  if (backoff && Date.now() < backoff) return

  // A draft room open in this tab is sensed whether or not it is configured.
  const detected = detectedDraft()
  const targets = [...mappings]
  if (detected && !targets.some((m) => m.yahooLeagueId === detected.yahooLeagueId)) {
    targets.push({ leagueId: null, ...detected, adhoc: true })
  }
  if (!targets.length) return

  let refused = false
  for (const mapping of targets) {
    /*
     * A page is read from the site it lives on. Yahoo serves each sport from
     * its own host, so a basketball tab cannot fetch football's pages or the
     * reverse — and trying only reported errors against a league that was fine.
     */
    const host = (mapping.sensor && mapping.sensor.host) || (mapping.sport === 'nba' ? 'basketball.fantasysports.yahoo.com' : 'football.fantasysports.yahoo.com')
    if (!mapping.adhoc && location.host !== host) continue
    const key = mapping.leagueId ?? `adhoc:${mapping.yahooLeagueId}`
    // An ad-hoc draft room in this very tab is live by definition.
    const cadence = mapping.adhoc
      ? POLL_MS
      : mapping.sensor
        ? mapping.sensor.pollMs
        : IDLE_POLL_MS
    if (Date.now() < (nextDue.get(key) ?? 0)) continue
    try {
      /*
       * While games are on, the score is the thing worth reading; the draft
       * board is finished and will not change again. Both spellings are
       * accepted because the extension is reloaded by hand and the server is
       * not, so the two are never upgraded in the same moment.
       */
      const wants = mapping.sensor && mapping.sensor.wants
      if (!mapping.adhoc && (wants === 'score' || wants === 'matchup')) {
        const live = await pollScore(mapping)
        nextDue.set(key, Date.now() + jitter(cadence))
        await send(live)
        continue
      }
      // Always report, even with nothing to say. Before a draft starts there
      // are no picks, and a sensor that only speaks when it has picks is
      // indistinguishable from one that is dead — which is exactly the thing
      // you need to know at 9:55pm.
      const payload = await pollLeague(mapping)
      nextDue.set(key, Date.now() + jitter(cadence))
      // The shape goes with every push, not just the first. A team count
      // asserted once and never rechecked is how a 14-team mock was read as
      // twelve, collapsing two picks of every round onto one another.
      const shape = shapeOf(payload.rows)
      if (mapping.adhoc) {
        await send({
          type: 'detected',
          sport: mapping.sport,
          yahooLeagueId: mapping.yahooLeagueId,
          teamId: mapping.teamId,
          shape,
          order: payload.order,
          rows: payload.rows,
        })
        continue
      }
      // Awaiting the reply keeps the service worker alive until the POST lands.
      await send({ type: 'snapshot', ...payload, shape })
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      if (err && err.rateLimited) {
        failures++
        backoff = Date.now() + Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
        refused = true
      }
      // Tell the companion, not just the popup: silence is indistinguishable
      // from a quiet draft, and it would keep showing the last good board.
      await send({ type: 'error', leagueId: mapping.leagueId ?? 'detected', sport: mapping.sport, message })
      /*
       * Stop the whole round, do not carry on down the list. The backoff was
       * only ever checked at the top of the tick, so a refusal on the first
       * league still fired every remaining one — hammering hardest at the
       * moment of being told to stop, which is how a soft throttle became an
       * origin-wide block.
       */
      if (refused) break
    }
  }
  /*
   * Only a clean round clears the penalty. Clearing it inside the loop meant
   * one league succeeding erased the backoff another had just earned.
   */
  if (!refused) {
    backoff = 0
    failures = 0
  }
}

async function loadMappings(onReady) {
  const reply = await send({ type: 'leagues' })
  if (!reply || !reply.leagues) {
    // The companion is not running yet; try again rather than dying.
    setTimeout(() => loadMappings(onReady), 5000)
    return
  }
  mappings = reply.leagues
  if (onReady) onReady()
}

function start() {
  loadMappings(() => {
    if (!mappings.length) return
    clearInterval(timer)
    tick()
    timer = setInterval(tick, POLL_MS)
  })
  // A mock started mid-session adds a league the companion did not have when
  // this tab loaded. Re-reading the list means that heals itself instead of
  // needing a reload at exactly the wrong moment.
  clearInterval(mappingTimer)
  mappingTimer = setInterval(() => loadMappings(null), 30000)
}

start()
