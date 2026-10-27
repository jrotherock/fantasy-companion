/**
 * Who you will and will not draft, kept apart from what players are worth.
 *
 * Football surfaces its lists only as tags, so the board never quietly lies
 * about a player. Basketball keeps that for `like` and `avoid`. `never` goes
 * further in one place: the recommender does not offer the player, and does
 * not count him as someone you could take at your next turn — otherwise it
 * would rate waiting on a pick you would never make. He stays in the pool the
 * rest of the room drafts from, and his value is untouched.
 *
 * The lists live in data/preferences/nba.json, which is not committed: the
 * repository is public and league-mates could read your targets. Names, not
 * ids, so the file can be written by hand:
 *
 *   { "never": ["Joel Embiid"], "avoid": [], "like": [],
 *     "leagues": { "nba-hoops": { "like": ["Kawhi Leonard"] } } }
 *
 * League entries add to the shared lists. A league can also carry your own
 * view, which the shared lists cannot (it is a 9-cat view or a points view):
 * `order`, your ranking of a few players, which breaks the cards' near-ties
 * (plan.ts orderTiebreak); and `adjust`, per-game stats you expect instead of
 * the projection's ({"Tyrese Maxey": {"ast": 4.8}}; fgPct, ftPct, fga and fta are
 * shooting; gp sets games played, taken as given; min sets minutes, and every stat not stated follows them at the
 * same per-minute rate), which every card, tile and path then reads.
 */
import { NameIndex } from './join.js'
import type { NbaPlayer } from './types.js'
import { CATS, type Cat } from './value.js'

export type PrefTag = 'never' | 'avoid' | 'like'

interface Lists { never?: string[]; avoid?: string[]; like?: string[] }
interface LeagueLists extends Lists {
  order?: string[]
  adjust?: Record<string, Record<string, number>>
  /** Categories you are punting in this league (a 9-cat league): a move is not judged by what it does to them. */
  punts?: string[]
  /** Players you will not drop in this league, by name: no move offers them as the drop. */
  keep?: string[]
}
export interface PreferenceFile extends Lists {
  leagues?: Record<string, LeagueLists>
  /**
   * Your view of players in every league: minutes and games, by name. A league's own `adjust` adds to it and wins
   * stat by stat (2026-10-19: a role or an injury is the same in every league, so it is set once by default).
   */
  adjust?: Record<string, Record<string, number>>
  /** Return dates you have set for injured players, by name: YYYY-MM-DD. */
  returns?: Record<string, string | null>
  /**
   * Minutes you expect for a stretch, by name: `min` a game until `until` (YYYY-MM-DD, not included), in every
   * league; inside it the teammate-absence share is not added on top (2026-10-27: "JJJ's minutes go more to Ace, not
   * Filipowski; Ace around 30-31 while he's out").
   */
  windows?: Record<string, { min: number; until: string } | null>
}

export interface Preferences {
  tags: Map<string, PrefTag>
  /** The league's own ranking, by player id, first = most wanted. */
  order: string[]
  /** Expected per-game stats, minutes and games, by player id: every league's, with this league's own over them. */
  adjust: Map<string, Record<string, number>>
  /** Which stats in `adjust` are this league's own (the rest are every league's), by player id. */
  own: Map<string, Set<string>>
  /** Categories you are punting in this league, as you set them. */
  punts: Cat[]
  /** Player ids you will not drop in this league. */
  keep: string[]
  /** Names that matched nobody: a typo, or a player who has left the league. */
  unresolved: string[]
}

export function resolvePreferences(file: PreferenceFile | null, leagueId: string, index: NameIndex): Preferences {
  const tags = new Map<string, PrefTag>()
  const unresolved: string[] = []
  const order: string[] = []
  const adjust = new Map<string, Record<string, number>>()
  const own = new Map<string, Set<string>>()
  const league = file?.leagues?.[leagueId] ?? {}
  const punts = (league.punts ?? []).filter((c): c is Cat => (CATS as string[]).includes(c))
  const keep: string[] = []
  for (const name of league.keep ?? []) { const id = index.resolve(name, null); if (id) keep.push(id); else unresolved.push(name) }
  if (!file) return { tags, unresolved, order, adjust, own, punts, keep }
  // Weakest first, so a name on two lists ends up with the stronger tag.
  for (const tag of ['like', 'avoid', 'never'] as PrefTag[]) {
    for (const name of [...(file[tag] ?? []), ...(league[tag] ?? [])]) {
      const id = index.resolve(name, null)
      if (id) tags.set(id, tag)
      else unresolved.push(name)
    }
  }
  for (const name of league.order ?? []) {
    const id = index.resolve(name, null)
    if (id && !order.includes(id)) order.push(id)
    else if (!id) unresolved.push(name)
  }
  for (const [name, stats] of Object.entries(file.adjust ?? {})) {
    const id = index.resolve(name, null)
    if (id) adjust.set(id, { ...stats })
    else unresolved.push(name)
  }
  for (const [name, stats] of Object.entries(league.adjust ?? {})) {
    const id = index.resolve(name, null)
    if (!id) { unresolved.push(name); continue }
    adjust.set(id, { ...(adjust.get(id) ?? {}), ...stats })
    own.set(id, new Set(Object.keys(stats)))
  }
  return { tags, unresolved, order, adjust, own, punts, keep }
}

// Shooting: the percentages and the attempts that weight them.
const SHOOTING = new Set(['fgPct', 'ftPct', 'fga', 'fta'])

/** The players with your expected stats in place of the projection's; everyone else untouched. */
export function applyAdjustments(players: NbaPlayer[], adjust: Map<string, Record<string, number>>): NbaPlayer[] {
  if (!adjust.size) return players
  return players.map((p) => {
    const a = adjust.get(p.id)
    if (!a || !p.projection) return p
    const perGame: Record<string, number> = { ...p.projection.perGame }, shooting: Record<string, number | null> = { ...p.projection.shooting }
    // Minutes: whatever you do not state follows them, so {min: 22} alone is a smaller role at the same rates, and
    // {min: 33.6, ast: 9.2} keeps your assists and scales the rest (2026-10-19: DeRozan at 22 of 29 minutes).
    const was = p.projection.perGame.min
    if (Number.isFinite(a.min) && was > 0) {
      const f = a.min / was
      for (const k of Object.keys(perGame)) if (k !== 'min' && !(k in a)) perGame[k] *= f
      for (const k of ['fga', 'fta']) if (!(k in a) && shooting[k] != null) shooting[k] = (shooting[k] as number) * f
    }
    // Games are the projection's own field, taken as given (not blended with the player's history).
    for (const [k, v] of Object.entries(a)) if (Number.isFinite(v) && k !== 'gp') (SHOOTING.has(k) ? shooting : perGame)[k] = v
    const games = Number.isFinite(a.gp) ? { gp: a.gp, gpSource: 'you' as const } : {}
    return { ...p, projection: { ...p.projection, ...games, perGame: perGame as unknown as typeof p.projection.perGame, shooting: shooting as unknown as typeof p.projection.shooting } }
  })
}
