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
