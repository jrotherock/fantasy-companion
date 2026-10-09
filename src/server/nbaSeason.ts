/**
 * Basketball's season on the server: reads Yahoo, Sleeper and CBS for each
 * league and serves the league screen, the home tiles and the alerts.
 *
 * Yahoo's request budget is shared with football (yahooApi.ts keeps the daily
 * cap), so reads are paced by what can change: today's lineup and the
 * scoreboard every ten minutes while games are on, hourly otherwise; rosters
 * every half hour; settings and the calendar once a day. Before a league has
 * drafted, one roster read every six hours is enough to notice it has.
 *
 * Sleeper carries the stats: a dated game log per week and per-game
 * projections for every date of the current week, free and keyed by the same
 * player ids as the rest of the basketball data.
 *
 * Test leagues (ids ending -test) never call Yahoo: their snapshot is posted by
 * hand, the same rule as the draft's replays.
 *
 * Routes, under /api/nba/season:
 *   GET  :id                 the league screen
 *   GET  tiles               one tile per league, for the home screen
 *   GET  exposure            players rostered in more than one league
 *   GET  all                 every league's screen and the drafts under way
 *   POST :id/refresh         read this league again now
 *   POST :id/snapshot        a test league's snapshot, by hand
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './paths.js'
import * as yahooApi from './yahooApi.js'
import { parseStandings, parseTransactions } from './yahooParse.js'
import type { Alert } from './alerts.js'
import { handReturns, injuryNotesNow, liveDrafts, nbaPlayers, neverIds, seasonLeagues } from './nbaDraft.js'
import { parseGameWeeks, parseLeagueRosters, parseNbaScoreboard, parsePlayers, parseRosterDay, parseSeasonSettings } from '../nba/yahooSeason.js'
import { easternDate } from '../nba/sources.js'
import { parseSleeperDayProjections, parseSleeperLogs, designation, type Designation, type GameLog } from '../nba/outlook.js'
import { diffStatus, type StatusEvent } from '../nba/news.js'
import { buildSeasonView, losesStart, seasonTile, type SeasonTile, type SeasonView } from '../nba/seasonView.js'
import { weekOf, type SeasonLeague, type Snapshot, type World } from '../nba/inseason.js'
import type { Box } from '../nba/yahooSeason.js'
import type { Game, NbaPlayer } from '../nba/types.js'

const DATA = 'data/nba'
const DIR = join(STATE_DIR, 'nba-season')
const SEASON = 2026
const MIN = 60_000, HOUR = 60 * MIN

/**
 * The time, which a local test run may set (NBA_NOW, an ISO instant) to show a
 * mid-season screen before the season. Ignored on Railway.
 */
const clock = () => (process.env.NBA_NOW && !process.env.RAILWAY_ENVIRONMENT ? Date.parse(process.env.NBA_NOW) : Date.now())

const file = (name: string) => { mkdirSync(DIR, { recursive: true }); return join(DIR, name) }
const readJson = <T>(path: string, fallback: T): T => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback } catch { return fallback }
}

// ── Leagues ──

interface LeagueRow {
  id: string; label: string; leagueKey: string; scoring: 'points' | 'categories'; teams: number
  points?: Record<string, number>; roster: Record<string, number>
  adds?: { perWeek: number | null; season: number | null }; playoffWeeks?: number[]; myTeamId?: string
}

function leagues(): (SeasonLeague & { myTeamId: string | null })[] {
  return (seasonLeagues() as unknown as LeagueRow[]).map((l) => ({
    id: l.id, label: l.label, leagueKey: l.leagueKey, scoring: l.scoring, teams: l.teams,
    points: l.points, roster: l.roster,
    adds: l.adds ?? { perWeek: null, season: null },
    playoffWeeks: l.playoffWeeks ?? [],
    myTeamId: l.myTeamId ?? null,
  }))
}

const isTest = (id: string) => id.endsWith('-test')

// ── Snapshots ──

interface Stored extends Snapshot {
  /** When each part was last read, and the last error. */
  parts: Record<string, { at: number; error?: string | null; tried?: number }>
}

const emptySnap = (): Stored => ({
  at: 0, settings: null, weeks: [], rosters: [], mineToday: null, scoreboard: [], past: {}, standings: [], waivers: [], transactions: [], parts: {},
})

const snaps = new Map<string, Stored>()
function snapOf(id: string): Stored {
  let s = snaps.get(id)
  if (!s) { s = { ...emptySnap(), ...readJson<Partial<Stored>>(file(`${id}.json`), {}) }; snaps.set(id, s) }
  return s
}
function saveSnap(id: string, s: Stored) {
  s.at = Date.now()
  snaps.set(id, s)
  writeFileSync(file(`${id}.json`), JSON.stringify(s))
  views.delete(id)
}

// ── Sleeper: logs, projections, live player file ──

interface SleeperCache { logs: Record<number, { at: number; rows: GameLog[] }>; proj: Record<number, { at: number; rows: [string, { box: Box; min: number }][] }>; players: { at: number; byId: Record<string, { team: string | null; injury: string | null }> } | null }
let sleeper: SleeperCache = readJson(file('sleeper.json'), { logs: {}, proj: {}, players: null })
const saveSleeper = () => writeFileSync(file('sleeper.json'), JSON.stringify(sleeper))

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': 'fantasy-companion' } })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

/** Sleeper numbers its basketball weeks as Yahoo does: Monday to Sunday from the opener. */
async function refreshSleeper(weeks: Snapshot['weeks'], today: string) {
  const current = weekOf(weeks, today)?.[0]
  if (current == null) return
  let changed = false
  for (let w = 1; w <= current; w++) {
    const have = sleeper.logs[w]
    // A finished week never changes once it has been read after it ended.
    const done = w < current && have && have.at > Date.parse(weeks.find(([n]) => n === w)![2] + 'T23:59:00-05:00') + 12 * HOUR
    if (done) continue
    if (have && Date.now() - have.at < 30 * MIN) continue
    try {
      sleeper.logs[w] = { at: Date.now(), rows: parseSleeperLogs(await getJson(`https://api.sleeper.app/stats/nba/${SEASON}/${w}?season_type=regular`)) }
      changed = true
    } catch (e) { console.warn('nba season: sleeper logs', w, String(e)) }
  }
  const p = sleeper.proj[current]
  if (!p || Date.now() - p.at > 2 * HOUR) {
    try {
      sleeper.proj = { [current]: { at: Date.now(), rows: [...parseSleeperDayProjections(await getJson(`https://api.sleeper.app/projections/nba/${SEASON}/${current}?season_type=regular`))] } }
      changed = true
    } catch (e) { console.warn('nba season: sleeper projections', String(e)) }
  }
  if (!sleeper.players || Date.now() - sleeper.players.at > 3 * HOUR) {
    try {
      const all = await getJson('https://api.sleeper.app/v1/players/nba')
      const byId: Record<string, { team: string | null; injury: string | null }> = {}
      for (const [id, x] of Object.entries<any>(all)) if (x?.team || x?.injury_status) byId[id] = { team: x.team ?? null, injury: x.injury_status ?? null }
      sleeper.players = { at: Date.now(), byId }
      changed = true
    } catch (e) { console.warn('nba season: sleeper players', String(e)) }
  }
  if (changed) { saveSleeper(); views.clear() }
}

// ── The world every league shares ──

let schedule: Game[] | null = null
let noise: World['noise'] | null = null

function world(leagueId: string): World {
  schedule ??= JSON.parse(readFileSync(`${DATA}/schedule.json`, 'utf8')).games as Game[]
  noise ??= { sdWeekly: Object.fromEntries(Object.entries<any>(JSON.parse(readFileSync(`${DATA}/category-noise.json`, 'utf8')).raw).map(([k, v]) => [k, v.sdWeekly])) as any }
  const live = sleeper.players?.byId ?? {}
  // The player file was built before the season; Sleeper's live file has today's team and designation.
  const players: NbaPlayer[] = nbaPlayers().map((p) => {
    const l = live[p.id]
    if (!l) return p
    return { ...p, team: l.team ?? p.team, injury: l.injury ? { status: l.injury, body: p.injury?.body ?? null, notes: p.injury?.notes ?? null } : null }
  })
  const now = clock()
  return {
    players,
    logs: Object.values(sleeper.logs).flatMap((x) => x.rows),
    dayProj: new Map(Object.values(sleeper.proj).flatMap((x) => x.rows)),
    injuries: injuryNotesNow(),
    returns: handReturns(),
    schedule,
    noise: noise!,
    never: neverIds(leagueId),
    now,
    today: easternDate(now),
  }
}

// ── Status changes, for the news ──

interface StatusStore { last: Record<string, Designation>; events: StatusEvent[] }
let status: StatusStore = readJson(file('status.json'), { last: {}, events: [] })

/** Designations from every roster plus Sleeper's file; a change since the last read is news. */
function noteStatuses() {
  const cur: Record<string, Designation> = {}
  const live = sleeper.players?.byId ?? {}
  for (const [id, x] of Object.entries(live)) cur[id] = designation(x.injury)
  const ev = diffStatus(status.last, cur, Date.now())
  if (!Object.keys(status.last).length) { status = { last: cur, events: [] }; writeFileSync(file('status.json'), JSON.stringify(status)); return }
  if (ev.length || Object.keys(cur).length !== Object.keys(status.last).length) {
    status = { last: cur, events: [...status.events, ...ev].filter((e) => Date.now() - e.at < 4 * 24 * HOUR) }
    writeFileSync(file('status.json'), JSON.stringify(status))
    if (ev.length) views.clear()
  }
}

// ── Yahoo reads ──

/** Whether games are on or about to be: the first tip an hour away until three hours after the last. */
function gamesOn(now = clock()): boolean {
  schedule ??= JSON.parse(readFileSync(`${DATA}/schedule.json`, 'utf8')).games as Game[]
  const today = easternDate(now)
  const tips = schedule.filter((g) => g.date === today && g.tip).map((g) => Date.parse(g.tip!))
  if (!tips.length) return false
  return now >= Math.min(...tips) - HOUR && now <= Math.max(...tips) + 3 * HOUR
}

type Part = 'settings' | 'weeks' | 'rosters' | 'today' | 'scoreboard' | 'standings' | 'waivers' | 'transactions' | 'past'

function every(part: Part, drafted: boolean, live: boolean): number {
  if (!drafted) return part === 'rosters' || part === 'settings' || part === 'weeks' ? 6 * HOUR : Infinity
  switch (part) {
    case 'settings': case 'weeks': return 24 * HOUR
    case 'rosters': return live ? 15 * MIN : 30 * MIN
    case 'today': case 'scoreboard': return live ? 10 * MIN : HOUR
    case 'standings': return 3 * HOUR
    case 'waivers': return 2 * HOUR
    case 'transactions': return HOUR
    case 'past': return 12 * HOUR
  }
}

async function readLeague(l: SeasonLeague & { myTeamId: string | null }, force = false): Promise<void> {
  if (isTest(l.id) || !yahooApi.connected() || yahooApi.replaying()) return
  const s = snapOf(l.id)
  const drafted = s.rosters.some((r) => r.players.length > 0)
  const live = gamesOn()
  const key = l.leagueKey, gameKey = key.split('.')[0]
  const today = easternDate(Date.now())
  let changed = false
  const due = (p: Part) => {
    const st = s.parts[p]
    if (force) return true
    if (st?.error && st.tried && Date.now() - st.tried < 15 * MIN) return false
    return !st?.at || Date.now() - st.at >= every(p, drafted, live)
  }
  const run = async (p: Part, f: () => Promise<void>) => {
    if (!due(p)) return
    try { await f(); s.parts[p] = { at: Date.now() }; changed = true }
    catch (e) {
      s.parts[p] = { ...(s.parts[p] ?? { at: 0 }), error: String((e as Error)?.message ?? e), tried: Date.now() }
      changed = true
      // A refusal or the budget stops this round; the next one will try again.
      if (e instanceof yahooApi.YahooError && ['rate-limited', 'budget', 'auth'].includes(e.kind)) throw e
    }
  }
  try {
    await run('settings', async () => { s.settings = parseSeasonSettings(await yahooApi.call(`league/${key}/settings`, { by: 'nba-season' })) })
    await run('weeks', async () => { s.weeks = parseGameWeeks(await yahooApi.call(`game/${gameKey}/game_weeks`, { by: 'nba-season' })) })
    await run('rosters', async () => { s.rosters = parseLeagueRosters(await yahooApi.call(`league/${key}/teams/roster`, { by: 'nba-season' })) })
    const mine = s.rosters.find((r) => r.team.mine)?.team ?? s.rosters.find((r) => r.team.id === l.myTeamId)?.team
    if (s.rosters.some((r) => r.players.length) && mine) {
      await run('today', async () => { s.mineToday = parseRosterDay(await yahooApi.call(`team/${mine.key}/roster;date=${today}/players`, { by: 'nba-season' })) })
      await run('scoreboard', async () => { s.scoreboard = parseNbaScoreboard(await yahooApi.call(`league/${key}/scoreboard`, { by: 'nba-season' })) })
      await run('standings', async () => { s.standings = parseStandings(leagueBody(await yahooApi.call(`league/${key}/standings`, { by: 'nba-season' }))) })
      await run('waivers', async () => { s.waivers = parsePlayers(await yahooApi.call(`league/${key}/players;status=W;count=25`, { by: 'nba-season' })).map((p) => p.yahooId) })
      await run('transactions', async () => { s.transactions = parseTransactions(leagueBody(await yahooApi.call(`league/${key}/transactions;types=add,drop,trade;count=25`, { by: 'nba-season' }))) })
      await run('past', async () => {
        const current = weekOf(s.weeks, today)?.[0] ?? 0
        // Finished weeks are read once each.
        for (let w = 1; w < current; w++) {
          if (s.past[w]?.length && s.past[w].every((m) => m.status === 'postevent')) continue
          s.past[w] = parseNbaScoreboard(await yahooApi.call(`league/${key}/scoreboard;week=${w}`, { by: 'nba-season' }))
        }
      })
    }
  } catch (e) {
    console.warn(`nba season: ${l.id} stopped: ${String((e as Error)?.message ?? e)}`)
  }
  if (changed) saveSnap(l.id, s)
}

/** The body of a single-league answer, for football's parsers that take one. */
function leagueBody(json: any): Record<string, any> {
  const l = json?.fantasy_content?.league
  if (!Array.isArray(l)) return {}
  const out: Record<string, any> = {}
  for (const part of l.slice(1)) if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(out, part)
  return out
}

// ── Views ──

const views = new Map<string, { at: number; view: SeasonView }>()
/** A view goes stale on its own: games tip, and a lineup move stops being possible. */
const VIEW_TTL = 2 * MIN

export function seasonView(id: string): SeasonView | null {
  const l = leagues().find((x) => x.id === id)
  if (!l) return null
  const cached = views.get(id)
  if (cached && Date.now() - cached.at < VIEW_TTL) return cached.view
  const view = buildSeasonView(l, snapOf(id), world(id), status.events)
  views.set(id, { at: Date.now(), view })
  return view
}

/** Test leagues show on the home screen only in a local test run (NBA_NOW set), never in production. */
const showTest = () => !!process.env.NBA_NOW && !process.env.RAILWAY_ENVIRONMENT

export function seasonTiles(): SeasonTile[] {
  const live = new Map(liveDrafts(showTest()).filter((d) => !d.mock).map((d) => [d.id, d]))
  return leagues().filter((l) => !isTest(l.id) || showTest()).map((l) => {
    const t = seasonTile(seasonView(l.id)!, clock())
    // A draft under way outranks everything else the league could say.
    return live.has(l.id) ? { ...t, urgency: 'act' as const, action: 'Resume draft', why: 'Your draft is under way', link: `/nba/draft/${l.id}` } : t
  })
}

/** Every league's whole screen, for the cross-league News and Moves tabs, and the drafts under way. */
export function seasonAll(): { views: SeasonView[]; drafts: ReturnType<typeof liveDrafts> } {
  const views = leagues().filter((l) => !isTest(l.id) || showTest()).map((l) => seasonView(l.id)!).filter(Boolean)
  return { views, drafts: liveDrafts(showTest()) }
}

// ── Across leagues ──

export interface Exposure {
  playerId: string
  name: string
  leagues: { id: string; label: string; starting: boolean }[]
  status: Designation
  gameToday: boolean
}

export function exposure(): Exposure[] {
  const by = new Map<string, Exposure>()
  for (const l of leagues().filter((x) => !isTest(x.id))) {
    const v = seasonView(l.id)
    if (!v?.lineup) continue
    for (const r of v.lineup.rows) {
      const e = by.get(r.id) ?? { playerId: r.id, name: r.name, leagues: [], status: r.status, gameToday: !!r.game }
      e.leagues.push({ id: l.id, label: l.label, starting: !!r.slot && !['BN', 'IL', 'IL+'].includes(r.slot) })
      by.set(r.id, e)
    }
  }
  return [...by.values()].filter((e) => e.leagues.length > 1).sort((a, b) => b.leagues.length - a.leagues.length || a.name.localeCompare(b.name))
}

// ── Alerts ──

/**
 * What is worth a notification, from every basketball league. Football's
 * budget decides which get through (alerts.ts); these only say what each
 * costs to miss. A start lost tonight in a close week is the expensive one.
 */
export function nbaAlerts(now = clock()): Alert[] {
  const out: Alert[] = []
  for (const l of leagues().filter((x) => !isTest(x.id))) {
    const v = seasonView(l.id)
    if (!v || v.phase !== 'season') continue
    const name = (id: string | null) => (id ? v.players[id]?.name ?? id : '')
    const win = v.week?.odds?.win ?? v.week?.points?.win ?? 0.5
    const close = win > 0.2 && win < 0.8
    for (const m of v.lineup?.moves ?? []) {
      const by = m.by ? Date.parse(m.by) : null
      if (by == null || by - now > 2 * HOUR || by < now) continue
      if (!losesStart(m)) continue
      out.push({
        id: `nba-lineup:${l.id}:${v.today}:${m.start}`,
        leagueId: l.id, rule: 'nba-lineup',
        headline: `${l.label}: start ${name(m.start)}${m.bench ? ` for ${name(m.bench)}` : ''}`,
        detail: `${m.why}. Locks at tip.`,
        consequence: close ? 70 : 50,
        deadline: by,
        link: `/nba/league/${l.id}`,
        playerId: m.start,
      })
    }
  }
  // A player who starts in both leagues ruled out tonight.
  for (const e of exposure()) {
    if (!e.gameToday || !['out', 'injured', 'suspended'].includes(e.status)) continue
    if (e.leagues.filter((x) => x.starting).length < 2) continue
    out.push({
      id: `nba-exposure:${e.playerId}:${easternDate(now)}`,
      leagueId: e.leagues[0].id, rule: 'nba-exposure',
      headline: `${e.name} is ${e.status} — he starts in both basketball leagues`,
      detail: e.leagues.map((x) => x.label).join(' and '),
      consequence: 75,
      deadline: null,
      link: `/nba/league/${e.leagues[0].id}`,
      playerId: e.playerId,
    })
  }
  return out
}

// ── The loop ──

let timer: ReturnType<typeof setTimeout> | null = null
let running = false

async function round() {
  if (running) return
  running = true
  try {
    for (const l of leagues()) await readLeague(l)
    const weeks = leagues().map((l) => snapOf(l.id).weeks).find((w) => w.length) ?? []
    // Sleeper only matters once there is a season to read.
    if (weeks.length) await refreshSleeper(weeks, easternDate(Date.now()))
    noteStatuses()
  } catch (e) {
    console.warn('nba season round failed:', String((e as Error)?.message ?? e))
  } finally {
    running = false
  }
}

export function startNbaSeason() {
  if (timer) return
  const tick = async () => {
    await round()
    timer = setTimeout(tick, gamesOn() ? 5 * MIN : 15 * MIN)
  }
  timer = setTimeout(tick, 20_000)
}

// ── Routes ──

type Json = (res: any, code: number, body: unknown) => void

export async function handleNbaSeason(parts: string[], req: any, res: any, json: Json, body: (req: any) => Promise<any>): Promise<boolean> {
  if (parts[0] !== 'api' || parts[1] !== 'nba' || parts[2] !== 'season') return false
  const [, , , id, action] = parts
  if (req.method === 'GET' && id === 'tiles') { json(res, 200, seasonTiles()); return true }
  if (req.method === 'GET' && id === 'exposure') { json(res, 200, exposure()); return true }
  if (req.method === 'GET' && id === 'all') { json(res, 200, seasonAll()); return true }
  const l = leagues().find((x) => x.id === id)
  if (!l) { json(res, 404, { error: 'no such league' }); return true }
  if (req.method === 'GET' && !action) { json(res, 200, seasonView(id)); return true }
  if (req.method === 'POST' && action === 'refresh') {
    await readLeague(l, true)
    views.delete(id)
    json(res, 200, seasonView(id))
    return true
  }
  if (req.method === 'POST' && action === 'snapshot') {
    // Only a test league takes a hand-made snapshot: a real league is read from Yahoo.
    if (!isTest(id)) { json(res, 400, { error: 'only -test leagues take a snapshot by hand' }); return true }
    const b = await body(req)
    saveSnap(id, { ...emptySnap(), ...b, parts: {} })
    if (b.sleeperLogs) { sleeper.logs = { 1: { at: Date.now(), rows: b.sleeperLogs } }; views.clear() }
    if (b.statusEvents) status.events = b.statusEvents
    json(res, 200, seasonView(id))
    return true
  }
  json(res, 405, { error: 'method' })
  return true
}
