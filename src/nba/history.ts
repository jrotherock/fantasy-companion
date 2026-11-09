/**
 * What each league's screen said, day by day, kept so a week can be looked back on (2026-11-07: "save the odds so we
 * can do an anytime analysis"): the week's odds and each race, the score, where the team stands, and tonight's line
 * for each of my players with a game. A day keeps its first read (the morning's call) and its last before any of my
 * games tipped; a player's line is the last read before his own tip.
 */
import type { SeasonView } from './seasonView.js'
import type { Box } from './yahooSeason.js'
import type { Cat } from './value.js'
import type { GameLog } from './outlook.js'

export interface OddsEntry {
  at: number
  week: number
  start: string
  end: string
  opponent: string | null
  score: { mine: number | null; theirs: number | null }
  /** Categories: the chance of winning, tying, and categories expected; each race now and projected to the end. */
  cats: { win: number; tie: number; expected: number; races: { cat: Cat; mineNow: number; theirsNow: number; mine: number; theirs: number; win: number; tie: number }[] } | null
  /** Points: the score now and projected to the end, and the chance. */
  points: { mineNow: number; theirsNow: number; mine: number; theirs: number; win: number } | null
  standing: { rank: number | null; w: number | null; l: number | null; t: number | null } | null
  power: { rank: number; of: number; score: number } | null
}

export interface PlayerLine { name: string; min: number | null; play: number; box: Box }

export interface DayRecord {
  first: OddsEntry
  last: OddsEntry
  /** Tonight's line for my players with a game, as last read before each one's tip. */
  lines: Record<string, PlayerLine>
}

/** League id → date → the day's record. */
export type OddsHistory = Record<string, Record<string, DayRecord>>

const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d
const rbox = (b: Box): Box => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, r(v as number, 2)])) as unknown as Box

export function entryOf(v: SeasonView): OddsEntry | null {
  const w = v.week
  if (v.phase !== 'season' || !w) return null
  const me = v.power.find((p) => p.mine)
  return {
    at: v.at, week: w.week, start: w.start, end: w.end, opponent: w.opponent?.name ?? null, score: w.score,
    cats: w.odds ? {
      win: r(w.odds.win), tie: r(w.odds.tie), expected: r(w.odds.expected, 2),
      races: w.odds.races.map((c) => ({ cat: c.cat, mineNow: r(c.mineNow), theirsNow: r(c.theirsNow), mine: r(c.mine), theirs: r(c.theirs), win: r(c.win), tie: r(c.tie) })),
    } : null,
    points: w.points ? { mineNow: r(w.points.mineNow, 1), theirsNow: r(w.points.theirsNow, 1), mine: r(w.points.mine, 1), theirs: r(w.points.theirs, 1), win: r(w.points.win) } : null,
    standing: v.standing,
    power: me ? { rank: me.rank, of: v.power.length, score: r(me.score) } : null,
  }
}

/**
 * The view put into the history, in place: the day's first read stays, the last moves on until my first game of the
 * day tips, and each player's line moves on until his own tip. Returns whether anything changed.
 */
export function record(h: OddsHistory, leagueId: string, v: SeasonView, now: number): boolean {
  const e = entryOf(v)
  if (!e) return false
  // The view's week is the one it plans: after Sunday's last game that is next week, read under the next day.
  const date = v.addsOpen ?? v.today
  const days = (h[leagueId] ??= {})
  const day = days[date]
  const rows = v.addsOpen ? [] : v.lineup?.rows ?? []
  const before = (tip: string | null) => !tip || Date.parse(tip) > now
  const anyTipped = rows.some((x) => x.game && !before(x.game.tip))
  if (!day) days[date] = { first: e, last: e, lines: {} }
  else if (!anyTipped) day.last = e
  const lines = days[date].lines
  let changed = !day || !anyTipped
  for (const x of rows) {
    if (!x.game || !x.tonight || !before(x.game.tip) || x.game.started) continue
    lines[x.id] = { name: x.name, min: x.tonightMin != null ? r(x.tonightMin, 1) : null, play: r(x.play, 2), box: rbox(x.tonight) }
    changed = true
  }
  return changed
}

// ── Looking back ──

export interface WeekLook {
  week: number
  start: string
  end: string
  opponent: string | null
  /** The week's first read (Monday's call), and its latest. */
  opening: OddsEntry
  latest: OddsEntry
  /** The chance read each day, first and last of the day. */
  days: { date: string; first: number; last: number }[]
}

export interface LineCheck {
  /** Player-games with a saved line and a real one. */
  games: number
  /** Minutes and fantasy points: how far off on average, and which way (projected less real: positive ran high). */
  minErr: number | null; minBias: number | null
  fpErr: number; fpBias: number
  players: { id: string; name: string; games: number; min: number | null; realMin: number; fp: number; realFp: number }[]
}

export interface Review {
  weeks: WeekLook[]
  lines: LineCheck | null
}

const FPW: Partial<Record<keyof Box, number>> = { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 }
/** Fantasy points by the league's weights, or Harker's for a categories league: one yardstick for any line. */
const fpOf = (b: Box, w?: Partial<Record<string, number>> | null) => Object.entries(w && Object.keys(w).length ? w : FPW).reduce((t, [k, x]) => t + (x ?? 0) * ((b as unknown as Record<string, number>)[k] ?? 0), 0)

/** A league's history read back: each week opening against latest, and the saved lines against the games played. */
export function review(days: Record<string, DayRecord> | undefined, logs: GameLog[], weights?: Partial<Record<string, number>> | null): Review {
  const dates = Object.keys(days ?? {}).sort()
  const byWeek = new Map<number, string[]>()
  for (const d of dates) { const w = days![d].first.week; (byWeek.get(w) ?? byWeek.set(w, []).get(w)!).push(d) }
  const chance = (e: OddsEntry) => e.cats?.win ?? e.points?.win ?? 0
  const weeks: WeekLook[] = [...byWeek.entries()].sort((a, b) => b[0] - a[0]).map(([week, ds]) => {
    const opening = days![ds[0]].first, latest = days![ds[ds.length - 1]].last
    return { week, start: opening.start, end: opening.end, opponent: opening.opponent, opening, latest, days: ds.map((d) => ({ date: d, first: chance(days![d].first), last: chance(days![d].last) })) }
  })
  const real = new Map(logs.map((l) => [`${l.id}|${l.date}`, l]))
  const per = new Map<string, LineCheck['players'][number] & { minN: number }>()
  let n = 0, minN = 0, minErr = 0, minBias = 0, fpErr = 0, fpBias = 0
  for (const d of dates) for (const [id, x] of Object.entries(days![d].lines)) {
    const l = real.get(`${id}|${d}`)
    if (!l || l.min <= 0) continue
    const f = fpOf(x.box, weights), rf = fpOf(l.box, weights)
    n++; fpErr += Math.abs(f - rf); fpBias += f - rf
    if (x.min != null) { minN++; minErr += Math.abs(x.min - l.min); minBias += x.min - l.min }
    const p = per.get(id) ?? { id, name: x.name, games: 0, min: 0, realMin: 0, fp: 0, realFp: 0, minN: 0 }
    p.games++; p.fp += f; p.realFp += rf; p.realMin += l.min
    if (x.min != null) { p.minN++; p.min! += x.min }
    per.set(id, p)
  }
  const lines: LineCheck | null = n ? {
    games: n, minErr: minN ? r(minErr / minN, 2) : null, minBias: minN ? r(minBias / minN, 2) : null, fpErr: r(fpErr / n, 2), fpBias: r(fpBias / n, 2),
    players: [...per.values()].map(({ minN: m, ...p }) => ({ ...p, min: m ? r(p.min! / m, 1) : null, realMin: r(p.realMin / p.games, 1), fp: r(p.fp / p.games, 1), realFp: r(p.realFp / p.games, 1) }))
      .sort((a, b) => Math.abs(b.fp - b.realFp) - Math.abs(a.fp - a.realFp)),
  } : null
  return { weeks, lines }
}
