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
import { NameIndex } from '../nba/join.js'
import { adpFor } from '../nba/draft.js'
import { buildView, changes, prepare, type DraftView, type NbaLeague, type Prepared } from '../nba/plan.js'
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
  loaded = {
    players,
    index: new NameIndex(players.map((p) => ({ id: p.id, name: p.name, team: p.team }))),
    leagues,
    noise: JSON.parse(readFileSync(`${DATA}/category-noise.json`, 'utf8')).r,
  }
  return loaded
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

export function nbaLeagues(): NbaLeague[] {
  return load().leagues.filter((l) => !l.id.endsWith('-test'))
}

let byYahoo: Map<string, NbaPlayer> | null = null
export function playerByYahooId(yahooId: string): NbaPlayer | undefined {
  byYahoo ??= new Map(load().players.filter((p) => p.yahoo).map((p) => [p.yahoo!.yahooId, p]))
  return byYahoo.get(yahooId)
}

/** A snapshot from the Yahoo API, on the server. Same merge as the extension's, under its own name. */
export function ingestApi(leagueId: string, rows: YahooRow[], order: string[]) {
  const s = session(leagueId)
  if (!s) return
  const before = JSON.stringify([s.draft.picks, s.draft.slot, s.draft.order])
  ingestYahoo(s.draft, rows, order, s.league.myTeamName, s.league.teams, load().index, Date.now(), 'api')
  if (before !== JSON.stringify([s.draft.picks, s.draft.slot, s.draft.order])) save(s)
  else writeFileSync(fileOf(s.league.id), JSON.stringify(s.draft))
  if (s.view) s.view.sensor = s.draft.sensor
}

// ── Sessions ──

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
  const s: Session = { league, prep: prepare(league, players, noise, adpFor), draft, view: null, dirty: true }
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
  const next = buildView(s.prep, s.draft, tagsFor(s.league.id))
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
  if (!d.picks.length) return 120_000
  if (d.picks.length >= total) return 900_000
  return 15_000
}

function leaguesForExtension() {
  return load().leagues.filter((l) => !l.id.endsWith('-test')).map((l) => {
    const s = session(l.id)!
    const yahooLeagueId = l.leagueKey.split('.').pop()!
    return {
      id: l.id, label: l.label, sport: 'nba', platform: 'yahoo', leagueKey: l.leagueKey, myTeamName: l.myTeamName,
      scoring: l.scoring, teams: l.teams,
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
