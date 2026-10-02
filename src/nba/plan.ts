/**
 * Everything the basketball draft screen shows, worked out from a draft and
 * the league's numbers. Pure, so the server can call it on every change and
 * the tests can call it on a fixture.
 *
 * The screen answers, in order: is it my turn, who do I take, where is my
 * build going, which builds are still open to me, and who should I be
 * expecting to take over the next few rounds.
 *
 * Paths are worked out by drafting the rest of my picks forward against a room
 * that drafts down Yahoo's ADP — once per candidate build — and scoring each
 * finished roster on all nine categories. That one mechanism says both what a
 * build is worth from here and who it would take at each of my next turns.
 * The room never deviates from ADP and real rooms do, so the targets are the
 * likely shape of a path, not a promise.
 */
import { survival } from '../kernel/value.js'
import { nextPickFor, overallFor, roundFor, slotFor } from '../kernel/snake.js'
import {
  adviseCategories, advisePoints, baseline, contribution, expectedCats, readBuild, winChances, zero,
  BUILD_FIRM, BUILD_FROM, type Advice, type Baseline, type CanTake, type Strength,
} from './draft.js'
import { CATS, categoryZ, pointsValues, rankBuild, rosterSpots, type Cat, type CatRow, type PointsRow } from './value.js'
import { openSeats, positionalSlots, stillFeasible } from './lineup.js'
import { myPicks, teamsIn, type FeedItem, type StoredDraft } from './session.js'
import type { NbaPlayer } from './types.js'
import type { PrefTag } from './preferences.js'
import type { MockRecord } from './tendencies.js'
import { personKey, type Habit, type OpponentReport } from './opponents.js'

export interface NbaLeague {
  id: string
  label: string
  leagueKey: string
  myTeamName: string
  teams: number
  scoring: 'points' | 'categories'
  points?: Record<string, number>
  roster: Record<string, number>
  /** Older seasons Yahoo's renewal chain does not reach, by league id. */
  history?: { season: string; leagueId: string }[]
  /** Set on a Yahoo mock draft, which borrows a real league's settings for its own temporary league. */
  mock?: { yahooLeagueId: string; baseId: string; apiOk: boolean | null; createdAt: number }
}

/** The builds offered as paths. Pairs are the ones the punt literature and last season's team suggest. */
export const PATHS: { name: string; punt: Cat[] }[] = [
  { name: 'Balanced', punt: [] },
  { name: 'Punt FT%', punt: ['ft'] },
  { name: 'Punt FG%', punt: ['fg'] },
  { name: 'Punt AST', punt: ['ast'] },
  { name: 'Punt TO', punt: ['to'] },
  { name: 'Punt 3PM', punt: ['tpm'] },
  { name: 'Punt PTS', punt: ['pts'] },
  { name: 'Punt AST + TO', punt: ['ast', 'to'] },
  { name: 'Punt FT% + 3PM', punt: ['ft', 'tpm'] },
  { name: 'Punt REB + BLK', punt: ['reb', 'blk'] },
  { name: 'Punt FG% + TO', punt: ['fg', 'to'] },
]

export const CAT_LABEL: Record<Cat, string> = {
  fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO',
}

const nameOfPunt = (punt: Cat[]) =>
  PATHS.find((p) => p.punt.length === punt.length && p.punt.every((c) => punt.includes(c)))?.name ??
  (punt.length ? `Punt ${punt.map((c) => CAT_LABEL[c]).join(' + ')}` : 'Balanced')

/** What a league needs computed once, not on every pick. */
export interface Prepared {
  league: NbaLeague
  rounds: number
  players: Map<string, NbaPlayer>
  adp: (id: string) => number
  positions: (id: string) => string[]
  slots: string[]
  cats?: { rows: (CatRow & { adp: number })[]; byId: Map<string, CatRow & { adp: number }>; base: Baseline; byBuild: Map<string, Map<string, { value: number; rank: number }>> }
  points?: { rows: (PointsRow & { adp: number })[]; byId: Map<string, PointsRow & { adp: number }> }
  adpOrder: string[]
  /** Games a player's team plays in this league's playoff weeks, where the schedule is known. */
  playoff: (id: string) => number | null
  /** What most teams play in those weeks, so a number can be read as good or bad. */
  playoffNorm: number | null
}

/** Team code → games in each league's playoff weeks (data/nba/teams.json). */
export type PlayoffSchedule = Record<string, Record<string, number>>

/** The real league whose schedule a test or mock league borrows. */
const scheduleKey = (league: NbaLeague) => league.mock?.baseId ?? league.id.replace(/-test$/, '')

/**
 * The nine-category model is built for Yahoo's standard nine. A league that
 * scores anything else would be valued wrongly without a sound, so it fails
 * loudly instead; same for a points league with a stat the projections lack.
 */
export function checkScoring(league: NbaLeague & { categories?: string[] }) {
  if (league.scoring === 'categories') {
    const want = ['fg%', 'ft%', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
    const have = (league.categories ?? want).map((c) => c.toLowerCase())
    if (have.length !== want.length || want.some((c) => !have.includes(c))) {
      throw new Error(`${league.id} scores ${have.join(', ')}; the category model only knows Yahoo's standard nine`)
    }
  } else {
    const known = ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'tpm']
    const extra = Object.keys(league.points ?? {}).filter((k) => !known.includes(k))
    if (extra.length) throw new Error(`${league.id} scores ${extra.join(', ')}, which the points model does not project`)
  }
}

export function prepare(league: NbaLeague, players: NbaPlayer[], noise: Record<Cat, number>, adpFor: (p: NbaPlayer) => number, schedule: PlayoffSchedule = {}): Prepared {
  checkScoring(league)
  const byId = new Map(players.map((p) => [p.id, p]))
  const adp = (id: string) => adpFor(byId.get(id)!)
  const rounds = rosterSpots(league.roster)
  const positions = (id: string) => byId.get(id)?.yahoo?.positions ?? byId.get(id)?.positions ?? []
  const key = scheduleKey(league)
  const games = Object.values(schedule).map((t) => t[key]).filter((n): n is number => n != null).sort((a, b) => a - b)
  const playoff = (id: string) => {
    const team = byId.get(id)?.team
    return team && schedule[team]?.[key] != null ? schedule[team][key] : null
  }
  const prepared: Prepared = {
    league, rounds, players: byId, adp, positions, slots: positionalSlots(league.roster), adpOrder: [],
    playoff, playoffNorm: games.length ? games[Math.floor(games.length / 2)] : null,
  }
  if (league.scoring === 'categories') {
    const rows = categoryZ(players, league).map((r) => ({ ...r, adp: adp(r.id) }))
    const base = baseline(rows, league.teams, rounds, noise)
    prepared.cats = { rows, byId: new Map(rows.map((r) => [r.id, r])), base, byBuild: new Map() }
    prepared.adpOrder = [...rows].sort((a, b) => a.adp - b.adp).map((r) => r.id)
  } else {
    const rows = pointsValues(players, league as any).rows.map((r) => ({ ...r, adp: adp(r.id) }))
    prepared.points = { rows, byId: new Map(rows.map((r) => [r.id, r])) }
    prepared.adpOrder = [...rows].sort((a, b) => a.adp - b.adp).map((r) => r.id)
  }
  return prepared
}

/** Season value and rank of every player under one build, cached per build. */
function buildValues(prep: Prepared, punt: Cat[]) {
  const key = [...punt].sort().join('+')
  const cache = prep.cats!.byBuild
  if (!cache.has(key)) {
    cache.set(key, new Map(rankBuild(prep.cats!.rows, prep.league, punt).map((r) => [r.id, { value: r.value, rank: r.rank }])))
  }
  return cache.get(key)!
}

export interface BoardRow {
  id: string
  name: string
  team: string | null
  positions: string[]
  gp: number
  adp: number | null
  yahooRank: number | null
  value: number
  rank: number
  /** Season-weighted contribution per category (categories leagues). */
  contrib?: Record<Cat, number>
  /** Fantasy points per game (points leagues). */
  fpg?: number
  survives: number | null
  tag: PrefTag | null
  injury: string | null
  /** Games in this league's playoff weeks. */
  playoff: number | null
  takenAt: number | null
  takenBy: string | null
  mine: boolean
}

export interface PathView {
  name: string
  punt: Cat[]
  expected: number
  locked: boolean
  leading: boolean
  /** Who this path takes at each of my next picks, in the forward draft. */
  plan: { overall: number; round: number; id: string; name: string }[]
}

export interface DraftView {
  league: { id: string; label: string; scoring: NbaLeague['scoring']; teams: number; rounds: number; slot: number | null; slotSource: StoredDraft['slotSource']; myTeamName: string }
  clock: { overall: number; round: number; onClock: boolean; myNext: number | null; picksUntil: number | null; done: boolean }
  sensor: StoredDraft['sensor']
  roster: { id: string; name: string; team: string | null; positions: string[]; overall: number; round: number }[]
  openSeats: string[]
  build: null | {
    stage: 'open' | 'leaning' | 'firm'
    buildFrom: number
    buildFirm: number
    win: Record<Cat, number> | null
    punting: Cat[]
    edge: Cat[]
    strong: Cat[]
    locks: Cat[]
    expected: number | null
  }
  advice: (Advice & { team: string | null; positions: string[]; tag: PrefTag | null; canWait: boolean; contrib?: Record<Cat, number>; fpg?: number; gp: number; playoff: number | null; tiebreak?: boolean })[]
  /** When the first choices are too close to call and the playoff schedule separates them. */
  playoffNote: string | null
  playoffNorm: number | null
  paths: PathView[]
  ahead: { overall: number; round: number; players: { id: string; name: string; team: string | null; positions: string[]; survives: number; planned: boolean }[] }[]
  aheadBuild: string
  board: BoardRow[]
  log: { overall: number; round: number; name: string; manager: string | null; mine: boolean }[]
  feed: FeedItem[]
  /** The picks between now and my next turn: who makes them, and what their history says about them. */
  pickingBefore: { overall: number; round: number; manager: string | null; habits: Habit[]; seasons: number }[]
  /** Whether the league's history has been read; null for a mock, which has no league-mates. */
  history: null | { seasons: number; consistent: string[] }
  /** Once my roster is full: how it came out, and where I went my own way. */
  review: null | {
    expected: number | null
    win: Record<Cat, number> | null
    punting: Cat[]
    value: number | null
    followed: number
    advisedPicks: number
    departures: { round: number; took: string; advised: string }[]
  }
  mock: NbaLeague['mock'] | null
}

function canTakeFor(prep: Prepared, mine: string[], tags: Map<string, PrefTag>): CanTake {
  const have = mine.map(prep.positions)
  return (id, after) => {
    if (tags.get(id) === 'never') return false
    const roster = after ? [...have, prep.positions(after)] : have
    return stillFeasible(roster, prep.positions(id), prep.slots, prep.rounds - roster.length - 1)
  }
}

function strengthOf(prep: Prepared, ids: string[]): Strength {
  return ids.reduce((s, id) => {
    const r = prep.cats!.byId.get(id)
    if (!r) return s
    const c = contribution(r)
    return Object.fromEntries(CATS.map((k) => [k, s[k] + c[k]])) as Strength
  }, zero())
}

/**
 * The rest of my draft, played forward: the room takes the lowest ADP left,
 * I take what the advice says under `punt`. Returns my future picks and the
 * finished roster.
 */
function forward(prep: Prepared, taken: Set<string>, mine: string[], slot: number, from: number, punt: Cat[], tags: Map<string, PrefTag>) {
  const teams = prep.league.teams
  const gone = new Set(taken)
  const roster = [...mine]
  const plan: { overall: number; id: string }[] = []
  const last = teams * prep.rounds
  let cursor = 0
  for (let overall = from; overall <= last && roster.length < prep.rounds; overall++) {
    let id: string | undefined
    if (slotFor(overall, teams) === slot) {
      const spot = { teams, rounds: prep.rounds, slot, overall }
      const canTake = canTakeFor(prep, roster, tags)
      const advice = prep.cats
        ? adviseCategories(prep.cats.rows.filter((r) => !gone.has(r.id)), roster.map((x) => prep.cats!.byId.get(x)!).filter(Boolean), spot, prep.cats.base,
          { shortlist: 6, lookahead: 10, canTake, ignore: punt, neutralUntil: punt.length ? 0 : BUILD_FROM })
        : advisePoints(prep.points!.rows.filter((r) => !gone.has(r.id)), spot, 6, canTake)
      id = advice[0]?.id
      if (id) { roster.push(id); plan.push({ overall, id }) }
    } else {
      while (cursor < prep.adpOrder.length && gone.has(prep.adpOrder[cursor])) cursor++
      id = prep.adpOrder[cursor]
    }
    if (id) gone.add(id)
  }
  return { plan, roster }
}

export function buildView(prep: Prepared, d: StoredDraft, tags: Map<string, PrefTag>, opponents: OpponentReport | null = null): DraftView {
  const L = prep.league
  const teams = teamsIn(d, L.teams)
  const rounds = prep.rounds
  const takenAt = new Map(d.picks.map((p) => [p.playerId, p]))
  const taken = new Set(takenAt.keys())
  const overall = (d.picks.at(-1)?.overall ?? 0) + 1
  const done = overall > teams * rounds
  const slot = d.slot
  const mineP = slot == null ? [] : myPicks(d, teams, slotFor)
  const mine = mineP.map((p) => p.playerId)
  const onClock = !done && slot != null && slotFor(overall, teams) === slot
  const myNext = slot == null || done ? null : nextPickFor(slot, teams, rounds, overall - 1)
  const nextAfter = slot == null || myNext == null ? null : nextPickFor(slot, teams, rounds, myNext)
  const p = (id: string) => prep.players.get(id)!

  const canTake = canTakeFor(prep, mine, tags)
  const spot = myNext == null ? null : { teams, rounds, slot: slot!, overall: myNext }

  // ── Build ──
  let build: DraftView['build'] = null
  if (prep.cats) {
    const s = strengthOf(prep, mine)
    const read = readBuild(s, mine.length, prep.cats.base)
    const win = mine.length ? winChances(s, mine.length, prep.cats.base) : null
    build = {
      stage: read.stage, buildFrom: BUILD_FROM, buildFirm: BUILD_FIRM,
      win: read.stage === 'open' ? null : win,
      punting: read.stage === 'open' ? [] : read.punting,
      edge: read.stage === 'open' || !win ? [] : CATS.filter((c) => win[c] >= 0.35 && win[c] < 0.5),
      strong: read.stage === 'open' || !win ? [] : CATS.filter((c) => win[c] >= 0.65),
      locks: d.locks,
      expected: read.stage === 'open' ? null : expectedCats(s, mine.length, prep.cats.base),
    }
  }

  // ── Advice ──
  let advice: DraftView['advice'] = []
  let playoffNote: string | null = null
  if (spot) {
    const raw = prep.cats
      ? adviseCategories(prep.cats.rows.filter((r) => !taken.has(r.id)), mine.map((id) => prep.cats!.byId.get(id)!).filter(Boolean), spot, prep.cats.base,
        { canTake, neutralUntil: BUILD_FROM, ignore: d.locks })
      : advisePoints(prep.points!.rows.filter((r) => !taken.has(r.id)), spot, 25, canTake)
    // Fifteen, though the screen shows six: comparing mocks needs the score of whoever I took instead.
    advice = raw.slice(0, 15).map((a) => ({
      ...a, team: p(a.id).team, positions: prep.positions(a.id), tag: tags.get(a.id) ?? null,
      // "There next time" is the turn after this one; a player who will very likely still be there can wait.
      survives: nextAfter == null ? 0 : survival(prep.adp(a.id), nextAfter),
      canWait: nextAfter != null && survival(prep.adp(a.id), nextAfter) >= 0.6,
      contrib: prep.cats ? contribution(prep.cats.byId.get(a.id)!) : undefined,
      fpg: prep.points?.byId.get(a.id)?.fpg,
      gp: (prep.cats?.byId.get(a.id)?.games.gp ?? prep.points?.byId.get(a.id)?.games.gp) ?? 0,
      playoff: prep.playoff(a.id),
    }))
    const tb = playoffTiebreak(advice, prep.cats ? 0.02 : Math.abs(advice[0]?.score ?? 0) * 0.01)
    advice = tb.advice
    playoffNote = tb.note
  }

  // ── Paths and targets ahead ──
  const paths: PathView[] = []
  if (slot != null && !done) {
    const candidates = prep.cats ? PATHS.map((x) => x.punt) : [[]]
    if (prep.cats && d.locks.length && !candidates.some((c) => c.length === d.locks.length && c.every((x) => d.locks.includes(x)))) candidates.push(d.locks)
    for (const punt of candidates) {
      const f = forward(prep, taken, mine, slot, overall, punt, tags)
      const expected = prep.cats
        ? expectedCats(strengthOf(prep, f.roster), f.roster.length, prep.cats.base)
        : f.roster.reduce((n, id) => n + (prep.points!.byId.get(id)?.value ?? 0), 0)
      const locked = d.locks.length > 0 && punt.length === d.locks.length && punt.every((c) => d.locks.includes(c))
      paths.push({
        name: prep.cats ? nameOfPunt(punt) : 'Best value', punt, expected, locked, leading: false,
        plan: f.plan.map((x) => ({ overall: x.overall, round: roundFor(x.overall, teams), id: x.id, name: p(x.id).name })),
      })
    }
    paths.sort((a, b) => b.expected - a.expected)
    if (paths[0]) paths[0].leading = true
  }

  // Targets over the next five turns, for the locked build, else the leading path.
  const active = paths.find((x) => x.locked) ?? paths[0] ?? null
  const ahead: DraftView['ahead'] = []
  if (active && slot != null) {
    const planned = new Map(active.plan.map((x) => [x.overall, x.id]))
    const values = prep.cats ? buildValues(prep, active.punt) : null
    const valueOf = (id: string) => (values ? values.get(id)?.value : prep.points!.byId.get(id)?.value) ?? -Infinity
    // A player the plan takes at a later pick is not offered as an alternative at an earlier one.
    const used = new Set<string>(active.plan.map((x) => x.id))
    for (const x of active.plan.slice(1, 6)) {
      const pool = (prep.cats ? prep.cats.rows : prep.points!.rows)
        .filter((r) => !taken.has(r.id) && !used.has(r.id) && tags.get(r.id) !== 'never')
        .map((r) => ({ id: r.id, s: survival(prep.adp(r.id), x.overall) }))
        .filter((r) => r.s >= 0.35 && r.s < 0.97)
        .sort((a, b) => valueOf(b.id) - valueOf(a.id))
        .slice(0, 4)
      const plannedId = planned.get(x.overall)!
      const list = [{ id: plannedId, s: survival(prep.adp(plannedId), x.overall) }, ...pool.filter((r) => r.id !== plannedId).slice(0, 3)]
      list.forEach((r) => used.add(r.id))
      ahead.push({
        overall: x.overall, round: x.round,
        players: list.map((r) => ({ id: r.id, name: p(r.id).name, team: p(r.id).team, positions: prep.positions(r.id), survives: r.s, planned: r.id === plannedId })),
      })
    }
  }

  // ── Board ──
  const boardBuild = prep.cats ? (d.locks.length ? d.locks : active?.punt ?? []) : []
  const values = prep.cats ? buildValues(prep, boardBuild) : null
  const board: BoardRow[] = (prep.cats ? prep.cats.rows : prep.points!.rows).map((r) => {
    const pl = p(r.id)
    const v = values ? values.get(r.id)! : { value: (r as PointsRow).value, rank: (r as PointsRow).rank }
    const t = takenAt.get(r.id)
    return {
      id: r.id, name: pl.name, team: pl.team, positions: prep.positions(r.id),
      gp: r.games.gp, adp: pl.yahoo?.adp ?? null, yahooRank: pl.yahoo?.rank ?? null,
      value: v.value, rank: v.rank,
      contrib: prep.cats ? contribution(r as CatRow) : undefined,
      fpg: prep.points ? (r as PointsRow).fpg : undefined,
      // Chance he lasts to the next decision: the pick after this one when I am on the clock.
      survives: (onClock ? nextAfter : myNext) == null ? null : survival(prep.adp(r.id), (onClock ? nextAfter : myNext)!),
      tag: tags.get(r.id) ?? null,
      injury: pl.injury?.status ?? null,
      playoff: prep.playoff(r.id),
      takenAt: t?.overall ?? null, takenBy: t?.manager ?? null,
      mine: mine.includes(r.id),
    }
  }).sort((a, b) => a.rank - b.rank).slice(0, 320)

  // ── Review, once the roster is full ──
  let review: DraftView['review'] = null
  if (mine.length >= rounds) {
    const advised = d.advised ?? {}
    const asked = mineP.filter((x) => advised[x.overall])
    const departures = asked.filter((x) => advised[x.overall] !== x.playerId)
      .map((x) => ({ round: roundFor(x.overall, teams), took: p(x.playerId).name, advised: p(advised[x.overall]).name }))
    const s = prep.cats ? strengthOf(prep, mine) : null
    const win = s ? winChances(s, mine.length, prep.cats!.base) : null
    review = {
      expected: s ? expectedCats(s, mine.length, prep.cats!.base) : null,
      win,
      punting: win ? CATS.filter((c) => win[c] < 0.35) : [],
      value: prep.points ? mine.reduce((n, id) => n + (prep.points!.byId.get(id)?.value ?? 0), 0) : null,
      followed: asked.length - departures.length,
      advisedPicks: asked.length,
      departures,
    }
  }

  // ── Who picks before my next turn ──
  const pickingBefore: DraftView['pickingBefore'] = []
  if (myNext != null && !onClock) {
    for (let o = overall; o < myNext && pickingBefore.length < 15; o++) {
      const seat = slotFor(o, teams)
      const manager = d.managers?.[seat - 1] ?? null
      const prof = manager ? opponents?.managers[personKey(manager)] : undefined
      pickingBefore.push({ overall: o, round: roundFor(o, teams), manager, habits: prof?.habits ?? [], seasons: prof?.seasons ?? 0 })
    }
  }
  const history = L.mock ? null : {
    seasons: opponents?.seasons.length ?? 0,
    consistent: opponents ? Object.entries(opponents.validation).filter(([, v]) => v.consistent).map(([k]) => k) : [],
  }

  return {
    pickingBefore,
    history,
    review,
    mock: L.mock ?? null,
    playoffNote,
    playoffNorm: prep.playoffNorm,
    league: { id: L.id, label: L.label, scoring: L.scoring, teams, rounds, slot, slotSource: d.slotSource, myTeamName: L.myTeamName },
    clock: { overall: done ? teams * rounds : overall, round: roundFor(Math.min(overall, teams * rounds), teams), onClock, myNext, picksUntil: myNext == null ? null : myNext - overall, done },
    sensor: d.sensor,
    roster: mineP.map((x) => ({ id: x.playerId, name: p(x.playerId).name, team: p(x.playerId).team, positions: prep.positions(x.playerId), overall: x.overall, round: roundFor(x.overall, teams) })),
    openSeats: openSeats(mine.map(prep.positions), prep.slots),
    build,
    advice,
    paths: paths.slice(0, prep.cats ? 12 : 1),
    ahead,
    aheadBuild: active?.name ?? '',
    board,
    log: [...d.picks].reverse().slice(0, 30).map((x) => ({
      overall: x.overall, round: roundFor(x.overall, teams), name: x.name, manager: x.manager ?? null,
      mine: slot != null && slotFor(x.overall, teams) === slot,
    })),
    feed: [...d.feed].reverse().slice(0, 20),
  }
}

/**
 * What changed since the last view that is worth a line in the feed. Only
 * things that change a decision: the build being read for the first time or
 * turning, a lock that has stopped paying, a target taken just before me.
 */
export function changes(prev: DraftView | null, next: DraftView, now = Date.now()): FeedItem[] {
  if (!prev) return []
  const out: FeedItem[] = []
  const label = (cs: Cat[]) => cs.map((c) => CAT_LABEL[c]).join(', ')
  const pb = prev.build, nb = next.build
  if (pb && nb) {
    if (pb.stage === 'open' && nb.stage !== 'open') {
      out.push({ at: now, kind: 'build', text: nb.punting.length ? `Build read: you are punting ${label(nb.punting)}` : `Build read: nothing given up yet; weakest are ${label(CATS.filter((c) => nb.win && nb.win[c] < 0.5).slice(0, 2))}` })
    } else if (pb.stage !== 'open' && nb.stage !== 'open' && label(pb.punting) !== label(nb.punting)) {
      out.push({ at: now, kind: 'build', text: nb.punting.length ? `Build turned: now punting ${label(nb.punting)}` : `Build turned: no longer punting ${label(pb.punting)}` })
    }
    if (pb.stage === 'leaning' && nb.stage === 'firm') out.push({ at: now, kind: 'build', text: `Build is firm from here${nb.punting.length ? `: punt ${label(nb.punting)}` : ''}` })
    for (const c of nb.locks) {
      if (nb.win && nb.win[c] >= 0.55 && !(pb.win && pb.win[c] >= 0.55)) out.push({ at: now, kind: 'lock', text: `You locked ${CAT_LABEL[c]} as a punt, but you are winning it ${(nb.win[c] * 100).toFixed(0)}% of weeks` })
    }
  }
  const lockedPrev = prev.paths.find((x) => x.locked), lockedNext = next.paths.find((x) => x.locked), best = next.paths[0]
  if (lockedNext && best && !best.locked && best.expected - lockedNext.expected >= 0.3 && !(lockedPrev && prev.paths[0] && prev.paths[0].expected - lockedPrev.expected >= 0.3)) {
    out.push({ at: now, kind: 'lock', text: `${best.name} now projects ${(best.expected - lockedNext.expected).toFixed(1)} more categories a week than your locked ${lockedNext.name}` })
  }
  const nextTargets = new Set(prev.ahead[0]?.players.map((x) => x.id) ?? [])
  const prevTaken = new Set(prev.board.filter((r) => r.takenAt != null).map((r) => r.id))
  for (const r of next.board) {
    // Only a loss if he went before the pick he was the target for.
    if (r.takenAt != null && !prevTaken.has(r.id) && !r.mine && nextTargets.has(r.id) && r.takenAt < (prev.ahead[0]?.overall ?? 0)) out.push({ at: now, kind: 'target', text: `${r.name}, a target for pick ${prev.ahead[0]?.overall}, went at ${r.takenAt}${r.takenBy ? ` to ${r.takenBy}` : ''}` })
  }
  // Runs: four of the last six picks at one position group.
  const recent = next.board.filter((r) => r.takenAt != null && r.takenAt > next.clock.overall - 7).map((r) => r.positions)
  const isBig = (ps: string[]) => ps.includes('C') && !ps.some((x) => x === 'PG' || x === 'SG')
  const isGuard = (ps: string[]) => ps.includes('PG') && !ps.includes('C')
  for (const [kind, test] of [['centres', isBig], ['point guards', isGuard]] as const) {
    const n = recent.filter(test).length
    const before = prev.board.filter((r) => r.takenAt != null && r.takenAt > prev.clock.overall - 7).map((r) => r.positions).filter(test).length
    if (n >= 4 && before < 4) out.push({ at: now, kind: 'run', text: `Run on ${kind}: ${n} of the last six picks` })
  }
  return out
}

export { overallFor }

/**
 * A finished draft as one record for comparing mocks. The cost of a pick is
 * the advice's first choice less the pick made, in the advice's own score, at
 * the turn it was made; a pick from outside the list the screen kept is costed
 * at the list's last entry, which understates it.
 */
export function recordOf(prep: Prepared, d: StoredDraft, tags: Map<string, PrefTag>): MockRecord | null {
  const view = buildView(prep, d, tags)
  if (!view.review) return null
  const teams = view.league.teams
  const mine = d.slot == null ? [] : myPicks(d, teams, slotFor)
  const name = (id: string) => prep.players.get(id)?.name ?? id
  const picks = mine.map((x) => {
    const turn = d.turns?.[x.overall]
    const top = turn?.advice[0]
    const took = turn?.advice.find((a) => a.id === x.playerId)
    const cost = !top ? null : took ? top.score - took.score : top.score - turn!.advice[turn!.advice.length - 1].score
    return {
      overall: x.overall, round: roundFor(x.overall, teams),
      took: name(x.playerId), tookPositions: prep.positions(x.playerId),
      advised: top ? name(top.id) : null, advisedPositions: top ? prep.positions(top.id) : [],
      cost,
      waitedWrong: !!(top && took && took.id !== top.id && took.canWait && !top.canWait),
      stage: turn?.stage ?? null,
    }
  })
  const firstLocked = mine.find((x) => (d.turns?.[x.overall]?.locks.length ?? 0) > 0)
  return {
    id: d.leagueId,
    when: d.feed[0]?.at ?? d.turns?.[mine[0]?.overall ?? 0]?.at ?? 0,
    seat: d.slot,
    result: view.review.expected ?? view.review.value ?? 0,
    punting: view.review.punting,
    win: view.review.win,
    locks: d.locks,
    lockedFromRound: firstLocked ? roundFor(firstLocked.overall, teams) : null,
    picks,
  }
}

/**
 * The playoff schedule as a tiebreaker, and only that. Among the options that
 * score within `margin` of the first choice — a gap the projections cannot
 * honestly separate — the one whose team plays more games in this league's
 * playoff weeks goes first. A clear gap is never overruled: the schedule is
 * three weeks of twenty.
 */
export function playoffTiebreak<T extends { name: string; score: number; playoff: number | null; tiebreak?: boolean }>(advice: T[], margin: number): { advice: T[]; note: string | null } {
  if (advice.length < 2) return { advice, note: null }
  const top = advice[0].score
  const close = advice.filter((a) => top - a.score <= margin)
  if (close.length < 2) return { advice, note: null }
  const known = close.filter((a) => a.playoff != null)
  const most = Math.max(...known.map((a) => a.playoff!))
  const least = Math.min(...known.map((a) => a.playoff!))
  if (known.length < 2 || most === least) return { advice, note: null }
  const reordered = [...close].sort((a, b) => (b.playoff ?? -1) - (a.playoff ?? -1) || b.score - a.score)
  const moved = reordered[0] !== advice[0]
  const out = [...reordered.map((a, i) => (i === 0 && moved ? { ...a, tiebreak: true } : a)), ...advice.slice(close.length)]
  const lead = reordered[0], other = reordered.find((a) => a.playoff === least)!
  return {
    advice: out,
    note: `${close.map((a) => a.name).join(', ')} are too close to call; ${lead.name} plays ${lead.playoff} games in your playoff weeks, ${other.name} ${other.playoff}${moved ? ' — so he goes first' : ''}.`,
  }
}
