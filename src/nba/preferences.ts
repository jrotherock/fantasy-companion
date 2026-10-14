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
 * shooting), which every card, tile and path then reads.
 */
import { NameIndex } from './join.js'
import type { NbaPlayer } from './types.js'

export type PrefTag = 'never' | 'avoid' | 'like'

interface Lists { never?: string[]; avoid?: string[]; like?: string[] }
interface LeagueLists extends Lists {
  order?: string[]
  adjust?: Record<string, Record<string, number>>
}
export interface PreferenceFile extends Lists {
  leagues?: Record<string, LeagueLists>
  /** Return dates you have set for injured players, by name: YYYY-MM-DD. */
  returns?: Record<string, string | null>
}

export interface Preferences {
  tags: Map<string, PrefTag>
  /** The league's own ranking, by player id, first = most wanted. */
  order: string[]
  /** The league's own expected per-game stats, by player id. */
  adjust: Map<string, Record<string, number>>
  /** Names that matched nobody: a typo, or a player who has left the league. */
  unresolved: string[]
}

export function resolvePreferences(file: PreferenceFile | null, leagueId: string, index: NameIndex): Preferences {
  const tags = new Map<string, PrefTag>()
  const unresolved: string[] = []
  const order: string[] = []
  const adjust = new Map<string, Record<string, number>>()
  if (!file) return { tags, unresolved, order, adjust }
  const league = file.leagues?.[leagueId] ?? {}
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
  for (const [name, stats] of Object.entries(league.adjust ?? {})) {
    const id = index.resolve(name, null)
    if (id) adjust.set(id, stats)
    else unresolved.push(name)
  }
  return { tags, unresolved, order, adjust }
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
    for (const [k, v] of Object.entries(a)) if (Number.isFinite(v)) (SHOOTING.has(k) ? shooting : perGame)[k] = v
    return { ...p, projection: { ...p.projection, perGame: perGame as unknown as typeof p.projection.perGame, shooting: shooting as unknown as typeof p.projection.shooting } }
  })
}
