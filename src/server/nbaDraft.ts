/**
 * Basketball drafts on the server: one session per league, persisted in the
 * state directory, fed by the browser extension and by hand.
 *
 * Kept apart from football's sessions on purpose. Football is mid-season and
 * its draft code serves its own leagues; basketball has a different board, a
 * different value model and a different screen, and sharing a session type
 * would mean every change here risked a league that is being played.
 *
 * Routes, all under /api/nba:
 *   GET  leagues                    leagues, with the extension's polling instructions
 *   GET  draft/:id                  the screen's whole view
 *   GET  players?q=                 search for manual entry
 *   POST draft/:id/yahoo            a snapshot from the extension {rows, order} or {error}
 *   POST draft/:id/pick             {playerId}
 *   POST draft/:id/undo
 *   POST draft/:id/slot             {slot}
 *   POST draft/:id/locks            {locks}
 *   POST draft/:id/tag              {playerId, tag}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './paths.js'
import * as yahooApi from './yahooApi.js'
import { NameIndex } from '../nba/join.js'
import { adpFor } from '../nba/draft.js'
import { buildView, changes, prepare, recordOf, type DraftView, type NbaLeague, type Prepared } from '../nba/plan.js'
import { analyseMocks, type MockRecord } from '../nba/tendencies.js'
import { backtest, fetchHistory, historyStatus, opponentReport } from './nbaHistory.js'
import { addManual, emptyDraft, ingestYahoo, setLocks, setSlot, undoManual, type StoredDraft, type YahooRow } from '../nba/session.js'
import { resolvePreferences, type PreferenceFile, type PrefTag } from '../nba/preferences.js'
import { CATS, type Cat } from '../nba/value.js'
import type { NbaPlayer } from '../nba/types.js'

const DATA = 'data/nba'
const PREFS = join(STATE_DIR, 'nba-preferences.json')

interface Loaded {
  players: NbaPlayer[]
  index: NameIndex
  leagues: NbaLeague[]
  noise: Record<Cat, number>
}

let loaded: Loaded | null = null
function load(): Loaded {
  if (loaded) return loaded
  const players: NbaPlayer[] = JSON.parse(readFileSync(`${DATA}/players.json`, 'utf8')).players
  const leagues: NbaLeague[] = JSON.parse(readFileSync(`${DATA}/leagues.json`, 'utf8')).leagues
  /*
   * Throwaway leagues for replaying a real draft through the screen live in
   * the state directory, never in the repository, and must end in -test, so a
   * replay can never be pointed at a league that is really drafting.
   */
  const local = join(STATE_DIR, 'nba-leagues.local.json')
  if (existsSync(local)) {
    for (const l of JSON.parse(readFileSync(local, 'utf8')).leagues as NbaLeague[]) {
      if (l.id.endsWith('-test')) leagues.push(l)
    }
  }
  for (const m of readMocks()) {
    const base = leagues.find((l) => l.id === m.baseId)
    if (base) leagues.push(mockLeague(base, m))
  }
  loaded = {
    players,
    index: new NameIndex(players.map((p) => ({ id: p.id, name: p.name, team: p.team }))),
    leagues,
    noise: JSON.parse(readFileSync(`${DATA}/category-noise.json`, 'utf8')).r,
  }
  return loaded
}

// ── Mock drafts ──
//
// A Yahoo mock is a temporary league of its own, sensed when its draft room is
// open in the browser. It borrows the settings, values and screen of the real
// league with the same number of teams, and lives in the state directory, so it
// can never touch a real league's draft. The API is tried once for it; Yahoo
// has refused finished mocks, so the extension is expected to carry most.

type MockEntry = NonNullable<NbaLeague['mock']> & { id: string; teams: number }
const MOCKS = join(STATE_DIR, 'nba-mocks.json')

function readMocks(): MockEntry[] {
  return existsSync(MOCKS) ? JSON.parse(readFileSync(MOCKS, 'utf8')) : []
}
function writeMocks(list: MockEntry[]) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(MOCKS, JSON.stringify(list, null, 1))
}

function mockLeague(base: NbaLeague, m: MockEntry): NbaLeague {
  const game = base.leagueKey.split('.')[0]
  return {
    ...base, id: m.id, teams: m.teams, myTeamName: '',
    label: `Mock · ${base.label.replace(/ \(test\)$/, '')}`,
    leagueKey: `${game}.l.${m.yahooLeagueId}`,
    mock: { yahooLeagueId: m.yahooLeagueId, baseId: m.baseId, apiOk: m.apiOk, createdAt: m.createdAt },
  }
}

let onApiMock: (() => void) | null = null
/** The API reader asks to be woken when a mock turns out to be readable. */
export function onReadableMock(f: () => void) { onApiMock = f }

/** One API read decides whether the server can follow this mock itself. */
async function tryApi(m: MockEntry) {
  let ok = false
  // With no Yahoo connection there is nothing to try: the extension reads it.
  if (yahooApi.connected() && !yahooApi.replaying()) try {
    await yahooApi.call(`league/${load().leagues.find((l) => l.id === m.id)!.leagueKey}/draftresults`)
    ok = true
  } catch { ok = false }
  const list = readMocks().map((x) => (x.id === m.id ? { ...x, apiOk: ok } : x))
  writeMocks(list)
  const l = load().leagues.find((x) => x.id === m.id)
  if (l?.mock) l.mock.apiOk = ok
  const sess = sessions.get(m.id)
  if (sess) { sess.league = l!; sess.dirty = true }
  if (ok) onApiMock?.()
}

/**
 * A draft room the companion has not seen. The team count comes from round
 * one's listed order where the page has it, else from a round boundary — an
 * early `max(pickInRound)` is only a lower bound, which football learned when a
 * mock was built with one team.
 */
function detectMock(yahooLeagueId: string, rows: YahooRow[], order: string[]): MockEntry | null {
  const id = `nba-mock-${yahooLeagueId}`
  const existing = readMocks().find((m) => m.id === id)
  if (existing) return existing
  const rounds = Math.max(0, ...rows.map((r) => r.round))
  const teams = order.length >= 4 ? order.length : rounds >= 2 ? Math.max(...rows.map((r) => r.pickInRound)) : 0
  if (teams < 4) return null
  const real = load().leagues.filter((l) => !l.mock && !l.id.endsWith('-test'))
  const base = real.find((l) => l.teams === teams) ?? [...real].sort((a, b) => Math.abs(a.teams - teams) - Math.abs(b.teams - teams))[0]
  if (!base) return null
  const m: MockEntry = { id, yahooLeagueId, baseId: base.id, teams, apiOk: null, createdAt: Date.now() }
  writeMocks([...readMocks(), m])
  load().leagues.push(mockLeague(base, m))
  void tryApi(m)
  return m
}

/** A mock named by hand — a pasted draft-room link — for when the extension cannot tell it is one. */
function registerMock(yahooLeagueId: string, baseId: string): MockEntry | null {
  const id = `nba-mock-${yahooLeagueId}`
  const existing = readMocks().find((m) => m.id === id)
  if (existing) return existing
  const base = load().leagues.find((l) => l.id === baseId && !l.mock)
  if (!base) return null
  const m: MockEntry = { id, yahooLeagueId, baseId, teams: base.teams, apiOk: null, createdAt: Date.now() }
  writeMocks([...readMocks(), m])
  load().leagues.push(mockLeague(base, m))
  void tryApi(m)
  return m
}

/** The league id out of anything Yahoo might put in a draft-room address, or a bare number. */
export function mockIdFrom(text: string): string | null {
  const t = text.trim()
  if (/^\d{3,}$/.test(t)) return t
  return /\/draftclient\/(?:[a-z0-9]+\/)?(\d{3,})/.exec(t)?.[1] ?? /\/nba\/(\d{3,})(?:\/|$)/.exec(t)?.[1] ?? null
}

function discardMock(id: string): boolean {
  const list = readMocks()
  if (!list.some((m) => m.id === id)) return false
  writeMocks(list.filter((m) => m.id !== id))
  const L = load()
  L.leagues = L.leagues.filter((l) => l.id !== id)
  sessions.delete(id)
  try { if (existsSync(fileOf(id))) writeFileSync(fileOf(id), JSON.stringify(emptyDraft(id))) } catch { /* nothing to clear */ }
  return true
}

// ── Preferences: one list for every basketball league, editable from the screen ──

function prefFile(): PreferenceFile {
  for (const path of [PREFS, 'data/preferences/nba.json']) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  }
  return { never: [], avoid: [], like: [] }
}

function tagsFor(leagueId: string): Map<string, PrefTag> {
  return resolvePreferences(prefFile(), leagueId, load().index).tags
}

/** Tags are written by name, so the file stays readable and survives a player-id change. */
function setTag(playerId: string, tag: PrefTag | null) {
  const p = load().players.find((x) => x.id === playerId)
  if (!p) return false
  const file = prefFile()
  const lists: PrefTag[] = ['never', 'avoid', 'like']
  const index = load().index
  for (const t of lists) file[t] = (file[t] ?? []).filter((n) => index.resolve(n, null) !== playerId)
  if (tag) file[tag] = [...(file[tag] ?? []), p.name]
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PREFS, JSON.stringify(file, null, 1))
  for (const s of sessions.values()) s.dirty = true
  return true
}

// ── For the API reader ──

/** Every seat filled: the reader can stop asking. */
export function draftDone(leagueId: string): boolean {
  const s = session(leagueId)
  if (!s) return true
  return s.draft.picks.length >= (s.draft.order.length || s.league.teams) * s.prep.rounds
}

export function nbaLeagues(): NbaLeague[] {
  return load().leagues.filter((l) => !l.id.endsWith('-test') && (!l.mock || l.mock.apiOk === true))
}

let byYahoo: Map<string, NbaPlayer> | null = null
export function playerByYahooId(yahooId: string): NbaPlayer | undefined {
  byYahoo ??= new Map(load().players.filter((p) => p.yahoo).map((p) => [p.yahoo!.yahooId, p]))
  return byYahoo.get(yahooId)
}

/** A snapshot from the Yahoo API, on the server. Same merge as the extension's, under its own name. */
export function ingestApi(leagueId: string, rows: YahooRow[], order: string[], managers: (string | null)[] = []) {
  const s = session(leagueId)
  if (!s) return
  if (managers.length && JSON.stringify(managers) !== JSON.stringify(s.draft.managers ?? [])) {
    s.draft.managers = managers
    s.dirty = true
  }
  const before = JSON.stringify([s.draft.picks, s.draft.slot, s.draft.order])
  ingestYahoo(s.draft, rows, order, s.league.myTeamName, s.league.teams, load().index, Date.now(), 'api')
  if (before !== JSON.stringify([s.draft.picks, s.draft.slot, s.draft.order])) save(s)
  else writeFileSync(fileOf(s.league.id), JSON.stringify(s.draft))
  if (s.view) s.view.sensor = s.draft.sensor
}

// ── Sessions ──

let playoffGames: Record<string, Record<string, number>> | null = null
/** Team → games in each league's playoff weeks, from the joined team table. */
function schedule() {
  playoffGames ??= Object.fromEntries(
    (JSON.parse(readFileSync(`${DATA}/teams.json`, 'utf8')).teams as { team: string; playoffGames: Record<string, number> }[])
      .map((t) => [t.team, t.playoffGames]),
  )
  return playoffGames
}

interface Session {
  league: NbaLeague
  prep: Prepared
  draft: StoredDraft
  view: DraftView | null
  dirty: boolean
}

const sessions = new Map<string, Session>()
const fileOf = (id: string) => join(STATE_DIR, `nba-draft-${id}.json`)

function session(id: string): Session | null {
  if (sessions.has(id)) return sessions.get(id)!
  const { players, leagues, noise } = load()
  const league = leagues.find((l) => l.id === id)
  if (!league) return null
  const draft: StoredDraft = existsSync(fileOf(id)) ? JSON.parse(readFileSync(fileOf(id), 'utf8')) : emptyDraft(id)
  const s: Session = { league, prep: prepare(league, players, noise, adpFor, schedule()), draft, view: null, dirty: true }
  sessions.set(id, s)
  return s
}

function save(s: Session) {
  mkdirSync(STATE_DIR, { recursive: true })
  s.draft.feed = s.draft.feed.slice(-200)
  writeFileSync(fileOf(s.league.id), JSON.stringify(s.draft))
  s.dirty = true
}

/** The view, worked out once per change rather than once per poll; the feed is what changed in between. */
function viewOf(s: Session): DraftView {
  if (!s.dirty && s.view) return s.view
  const next = buildView(s.prep, s.draft, tagsFor(s.league.id), s.league.mock ? null : opponentReport(s.league.id.replace(/-test$/, '')))
  // What the advice said when I was on the clock, so the review can say where I went my own way.
  if (next.clock.onClock && next.advice[0]) {
    s.draft.advised = { ...(s.draft.advised ?? {}), [next.clock.overall]: next.advice[0].id }
    s.draft.turns = {
      ...(s.draft.turns ?? {}),
      [next.clock.overall]: {
        at: Date.now(),
        advice: next.advice.map((a) => ({ id: a.id, score: a.score, survives: a.survives, canWait: a.canWait })),
        locks: [...s.draft.locks],
        stage: next.build?.stage ?? null,
      },
    }
  }
  const news = changes(s.view, next)
  if (news.length) {
    s.draft.feed.push(...news)
    writeFileSync(fileOf(s.league.id), JSON.stringify(s.draft))
    next.feed = [...s.draft.feed].reverse().slice(0, 20)
  }
  s.view = next
  s.dirty = false
  return next
}

/**
 * How often the extension should read Yahoo's results page. It is the backup
 * now — the server reads the API — so fifteen seconds while a draft is under
 * way, two minutes before the first pick, a quarter of an hour once it is
 * over. Yahoo answers a hot poll with HTTP 999 for the whole site, football
 * included, so a backup has no business polling like a primary.
 */
function cadence(s: Session): number {
  const d = s.draft
  const total = (d.order.length || s.league.teams) * s.prep.rounds
  if (d.picks.length >= total) return 900_000
  // A mock the API cannot read has only the extension, and bots pick at once.
  if (s.league.mock && s.league.mock.apiOk !== true) return 6_000
  if (!d.picks.length) return 120_000
  return 15_000
}

function leaguesForExtension() {
  return load().leagues.filter((l) => !l.id.endsWith('-test')).map((l) => {
    const s = session(l.id)!
    const yahooLeagueId = l.leagueKey.split('.').pop()!
    return {
      id: l.id, label: l.label, sport: 'nba', platform: 'yahoo', leagueKey: l.leagueKey, myTeamName: l.myTeamName,
      scoring: l.scoring, teams: l.teams, mock: l.mock ?? null,
      sensor: {
        pollMs: cadence(s), wants: 'draft',
        host: 'basketball.fantasysports.yahoo.com', path: `/nba/${yahooLeagueId}/draftresults`,
      },
      picks: s.draft.picks.length,
    }
  })
}

type Json = (res: any, code: number, body: unknown) => void

/** Answers anything under /api/nba. Returns false for paths it does not own. */
export async function handleNba(parts: string[], url: URL, req: any, res: any, json: Json, body: (req: any) => Promise<any>): Promise<boolean> {
  if (parts[1] !== 'nba') return false
  const [, , what, id, action] = parts

  if (what === 'leagues' && req.method === 'GET') {
    json(res, 200, leaguesForExtension())
    return true
  }

  if (what === 'players' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    const hits = q.length < 2 ? [] : load().players
      .filter((p) => p.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q))
      .sort((a, b) => (a.yahoo?.rank ?? 999) - (b.yahoo?.rank ?? 999))
      .slice(0, 12)
      .map((p) => ({ id: p.id, name: p.name, team: p.team, positions: p.yahoo?.positions ?? p.positions }))
    json(res, 200, hits)
    return true
  }

  // The league's draft history: read once from Yahoo (POST), then kept and analysed (GET).
  if (what === 'history' && id) {
    const league = load().leagues.find((l) => l.id === id && !l.mock)
    if (!league) { json(res, 404, { error: `no basketball league ${id}` }); return true }
    if (req.method === 'POST') {
      if (!yahooApi.connected() || yahooApi.replaying()) { json(res, 409, { error: 'reading history needs the Yahoo connection, which only the deployed app has' }); return true }
      void fetchHistory(league.id, league.leagueKey, league.history ?? []).then(() => { for (const s of sessions.values()) s.dirty = true })
      json(res, 202, { ok: true, started: true })
      return true
    }
    if (action === 'backtest') {
      const r = backtest(league.id)
      json(res, r ? 200 : 404, r ?? { error: 'no history read yet' })
      return true
    }
    json(res, 200, historyStatus(league.id))
    return true
  }

  // Every finished mock, grouped by the league it copies — the two formats are never pooled.
  if (what === 'tendencies' && req.method === 'GET') {
    const L = load()
    const out = L.leagues.filter((l) => !l.mock && !l.id.endsWith('-test')).map((league) => {
      const records = L.leagues.filter((l) => l.mock?.baseId === league.id)
        .map((l) => { const s = session(l.id)!; return recordOf(s.prep, s.draft, tagsFor(l.id)) })
        .filter((r): r is MockRecord => r != null)
      return { leagueId: league.id, label: league.label, scoring: league.scoring, report: analyseMocks(records, league.scoring) }
    })
    json(res, 200, out)
    return true
  }

  if (what === 'mock' && req.method === 'POST') {
    const data = await body(req)
    const yid = mockIdFrom(String(data.link ?? ''))
    if (!yid) { json(res, 400, { error: 'no league id in that link — paste the draft room address' }); return true }
    if (load().leagues.some((l) => !l.mock && l.leagueKey.endsWith(`.l.${yid}`))) { json(res, 400, { error: 'that is one of your real leagues, not a mock' }); return true }
    const m = registerMock(yid, String(data.baseId ?? ''))
    if (!m) { json(res, 400, { error: 'choose which league the mock copies' }); return true }
    json(res, 200, { ok: true, leagueId: m.id })
    return true
  }

  // A draft room the extension found open that the companion does not know: a mock.
  if (what === 'detect' && req.method === 'POST') {
    const data = await body(req)
    const rows: YahooRow[] = Array.isArray(data.rows) ? data.rows : []
    const order: string[] = Array.isArray(data.order) ? data.order.map(String) : []
    const yid = String(data.yahooLeagueId ?? '')
    if (!/^\d+$/.test(yid)) { json(res, 400, { error: 'no league id' }); return true }
    if (load().leagues.some((l) => !l.mock && l.leagueKey.endsWith(`.l.${yid}`))) { json(res, 200, { ok: false, reason: 'a configured league, not a mock' }); return true }
    const m = detectMock(yid, rows, order)
    if (!m) { json(res, 200, { ok: false, reason: 'not enough of the board to size the league yet' }); return true }
    const s = session(m.id)!
    ingestYahoo(s.draft, rows, order, '', s.league.teams, load().index, Date.now(), 'page')
    save(s)
    json(res, 200, { ok: true, leagueId: m.id, accepted: rows.length })
    return true
  }

  if (what !== 'draft' || !id) {
    json(res, 404, { error: 'not found' })
    return true
  }
  const s = session(id)
  if (!s) {
    json(res, 404, { error: `no basketball league ${id}` })
    return true
  }

  if (!action && req.method === 'GET') {
    json(res, 200, viewOf(s))
    return true
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'POST it' })
    return true
  }

  const data = await body(req)
  switch (action) {
    case 'yahoo': {
      if (data.error) {
        s.draft.sensor = { ...s.draft.sensor, ok: false, error: String(data.error) }
        save(s)
        json(res, 200, { ok: true })
        return true
      }
      const rows: YahooRow[] = Array.isArray(data.rows) ? data.rows : []
      const order: string[] = Array.isArray(data.order) ? data.order.map(String) : []
      const before = JSON.stringify([s.draft.picks, s.draft.slot, s.draft.order])
      const result = ingestYahoo(s.draft, rows, order, s.league.myTeamName, s.league.teams, load().index, Date.now(), 'page')
      // Every push refreshes the sensor's heartbeat; only a real change costs a recompute.
      const changed = before !== JSON.stringify([s.draft.picks, s.draft.slot, s.draft.order])
      if (changed) save(s)
      else writeFileSync(fileOf(s.league.id), JSON.stringify(s.draft))
      if (s.view) s.view.sensor = s.draft.sensor
      json(res, 200, { ok: true, ...result })
      return true
    }
    case 'pick': {
      const p = load().players.find((x) => x.id === String(data.playerId))
      if (!p) { json(res, 400, { error: 'unknown player' }); return true }
      const pick = addManual(s.draft, p.id, p.name)
      if (!pick) { json(res, 409, { error: `${p.name} is already drafted` }); return true }
      save(s)
      json(res, 200, { ok: true, pick })
      return true
    }
    case 'undo': {
      const undone = undoManual(s.draft)
      save(s)
      json(res, 200, { ok: true, undone })
      return true
    }
    case 'slot': {
      const slot = data.slot == null ? null : Number(data.slot)
      setSlot(s.draft, slot && slot > 0 ? slot : null)
      save(s)
      json(res, 200, { ok: true })
      return true
    }
    case 'locks': {
      const locks = (Array.isArray(data.locks) ? data.locks : []).filter((c: string) => (CATS as string[]).includes(c)) as Cat[]
      setLocks(s.draft, locks)
      save(s)
      json(res, 200, { ok: true, locks })
      return true
    }
    case 'discard': {
      const ok = s.league.mock ? discardMock(s.league.id) : false
      json(res, ok ? 200 : 400, ok ? { ok } : { error: 'only a mock can be discarded' })
      return true
    }
    case 'tag': {
      const tag = data.tag == null ? null : String(data.tag)
      if (tag != null && !['never', 'avoid', 'like'].includes(tag)) { json(res, 400, { error: 'tag is never, avoid, like or null' }); return true }
      const ok = setTag(String(data.playerId), tag as PrefTag | null)
      json(res, ok ? 200 : 400, { ok })
      return true
    }
  }
  json(res, 404, { error: 'not found' })
  return true
}
