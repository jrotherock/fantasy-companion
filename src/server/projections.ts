/**
 * Weekly projected points, from Sleeper.
 *
 * The matchup was comparing board value, which is value over replacement and
 * not a score — useful for drafting, meaningless for "am I winning on Sunday".
 * Sleeper publishes real per-week projections and half-PPR is the scoring all
 * four leagues use, so the honest number was available the whole time.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { PlayerId } from '../kernel/types.js'
import { statePath } from './paths.js'

/*
 * One file per week, and a copy in memory beside it.
 *
 * It was one file for whichever week was asked for last. That was fine while
 * only the current week was ever wanted; asking for three in a row — the
 * claim week and the two behind it, which is how the wire is ranked now —
 * made each call evict the last, so every one of them missed and went back to
 * Sleeper. Three round trips of half a second, on every request, for answers
 * the process had just had in its hands.
 */
const cacheFor = (season: string, week: number) =>
  statePath(`projections-${season}-${week}.json`)
const memo = new Map<string, { at: number; got: Projections }>()

/**
 * Drop what is held in memory. For tests, which reach in and write the cache
 * files themselves and would otherwise be answered from a previous test's
 * reading before they ever touched the disk.
 */
export function forgetProjections(): void { memo.clear() }
const MAX_AGE = 3600000
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DB', 'DL', 'LB']

interface Cache {
  at: number; week: number; season: string
  pts: Record<string, number>
  stats?: Record<string, Record<string, number>>
}

/**
 * Sleeper's projection key → the league scoring key it is paid under. Only the
 * defensive ones: everything on offence is already carried by `pts_half_ppr`.
 */
const IDP_KEYS: [string, string][] = [
  ['idp_tkl_solo', 'idp_tkl_solo'],
  ['idp_tkl_ast', 'idp_tkl_ast'],
  ['idp_sack', 'idp_sack'],
  ['idp_tkl_loss', 'idp_tfl'],
  ['idp_pass_def', 'idp_pass_def'],
  ['idp_int', 'idp_int'],
  ['idp_ff', 'idp_ff'],
  ['idp_fum_rec', 'idp_fum_rec'],
  ['idp_def_td', 'idp_td'],
  ['idp_safety', 'idp_safe'],
  ['idp_blk_kick', 'idp_blk_kick'],
]

/**
 * A defender's week, scored under the league he is in rather than under
 * half-PPR.
 *
 * `pts_half_ppr` pays a solo tackle nothing, so it projected T.J. Watt at 1.01
 * and Jack Campbell at 0.49 — every defender in the eighteen-team IDP league
 * arrived worth about a point, indistinguishable from each other and from a
 * waiver linebacker, and the start/sit optimiser had nothing to work with.
 * The components were in the same payload the whole time; only the total was
 * wrong. Campbell's week one is 16.9 under this league's own settings.
 */
export function scoreIdp(
  stats: Record<string, number> | undefined,
  scoring: Record<string, number> | undefined,
): number | null {
  if (!stats || !scoring) return null
  let total = 0
  let paid = false
  for (const [from, to] of IDP_KEYS) {
    const v = stats[from]
    const w = scoring[to]
    if (typeof v !== 'number' || typeof w !== 'number') continue
    total += v * w
    paid = true
  }
  return paid ? Number(total.toFixed(2)) : null
}

export interface Projections {
  week: number
  season: string
  at: number
  /** Player id → projected half-PPR points for the week. */
  pts: Map<PlayerId, number>
  /** The raw projected components, so a league can score them its own way. */
  stats: Map<PlayerId, Record<string, number>>
}

export async function weeklyProjections(season: string, week: number): Promise<Projections> {
  const key = `${season}:${week}`
  const CACHE = cacheFor(season, week)
  const warm = memo.get(key)
  if (warm && Date.now() - warm.at < MAX_AGE) return warm.got

  let held: Cache | null = null
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      if (c.week === week && c.season === season && Object.keys(c.pts ?? {}).length) {
        held = c
        if (Date.now() - c.at < MAX_AGE) {
          const got = {
            week, season, at: c.at,
            pts: new Map(Object.entries(c.pts)),
            stats: new Map(Object.entries(c.stats ?? {})),
          }
          memo.set(key, { at: c.at, got })
          return got
        }
      }
    } catch {
      // A torn cache is not worth failing over.
    }
  }

  const pts: Record<string, number> = {}
  const stats: Record<string, Record<string, number>> = {}
  const qs = POSITIONS.map((p) => `position[]=${p}`).join('&')
  try {
    const res = await fetch(
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${qs}&order_by=pts_half_ppr`,
      { headers: { 'user-agent': 'Mozilla/5.0 (fantasy companion, personal use)' } },
    )
    if (res.ok) {
      for (const row of (await res.json()) as any[]) {
        const id = row.player_id ?? row.player?.player_id
        if (!id) continue
        const v = row.stats?.pts_half_ppr
        // A projection of zero is a real answer — a player who is not playing.
        if (typeof v === 'number') pts[String(id)] = v
        // Kept whole: a defender's total has to be recomputed per league.
        if (row.stats) stats[String(id)] = row.stats
      }
    }
  } catch {
    // Fall through with whatever was gathered; the caller reports emptiness.
  }

  /*
   * An empty answer is a failed read, not a week in which nobody is projected.
   * It was cached like any other, and for the hour it lasted every comparison
   * in the app read nought — the trade finder reported no fit in every league,
   * the waiver targets went blank and the Sleeper matchup projected nobody —
   * with nothing on screen to say why. Keep the last good table for this week
   * instead, however old, and try again on the next request.
   */
  if (!Object.keys(pts).length) {
    if (held) {
      return {
        week, season, at: held.at,
        pts: new Map(Object.entries(held.pts)),
        stats: new Map(Object.entries(held.stats ?? {})),
      }
    }
    return { week, season, at: Date.now(), pts: new Map(), stats: new Map() }
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), week, season, pts, stats } satisfies Cache))
  const got = {
    week, season, at: Date.now(),
    pts: new Map(Object.entries(pts)),
    stats: new Map(Object.entries(stats)),
  }
  memo.set(key, { at: got.at, got })
  return got
}

/**
 * His level over several weeks, with a bye left out.
 *
 * A nought earned by the calendar says nothing about the player. Averaged in,
 * it marks every man whose bye falls soon as worse than he is; read as the
 * whole answer — one week, on the bye itself — it marks him as worth nothing
 * at all, which is how two top-twelve backs on their bye made their manager
 * read as the weakest at the position in his league. The bye is returned
 * separately because it is worth knowing on its own account.
 *
 * The window is however many tables are handed in, `tables[0]` being
 * `fromWeek`. A week that could not be read is skipped rather than counted as
 * nought, for the same reason.
 */
export function levelOver(
  tables: (Projections | null)[],
  id: PlayerId,
  pos: string | null | undefined,
  league: { scoring?: Record<string, number> } | null,
  fromWeek: number,
  byeWeek: number | null,
): { outlook: number | null; byeIn: number | null } {
  const vals = tables.flatMap((t, i) => {
    if (!t || (byeWeek != null && byeWeek === fromWeek + i)) return []
    const v = projFor(t, id, pos, league)
    return v == null ? [] : [v]
  })
  return {
    outlook: vals.length
      ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2))
      : null,
    byeIn: byeWeek != null && byeWeek >= fromWeek && byeWeek < fromWeek + tables.length
      ? byeWeek
      : null,
  }
}

/**
 * One player's projection under a league's own scoring.
 *
 * Lived in the request handler until the home screen needed it too: the tile
 * measures how a week is going against what was projected, and a tile scoring
 * a linebacker differently from the league page underneath it would be two
 * answers to one question.
 */
export function projFor(
  proj: { pts: Map<string, number>; stats: Map<string, Record<string, number>> },
  id: string,
  pos: string | null | undefined,
  league?: { scoring?: Record<string, number> } | null,
): number | null {
  if (pos && ['DB', 'DL', 'LB'].includes(String(pos).toUpperCase())) {
    const idp = scoreIdp(proj.stats.get(id), league?.scoring)
    if (idp != null) return idp
  }
  return proj.pts.get(id) ?? null
}
