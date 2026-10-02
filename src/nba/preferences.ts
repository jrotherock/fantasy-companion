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
 * League entries add to the shared lists.
 */
import { NameIndex } from './join.js'

export type PrefTag = 'never' | 'avoid' | 'like'

interface Lists { never?: string[]; avoid?: string[]; like?: string[] }
export interface PreferenceFile extends Lists {
  leagues?: Record<string, Lists>
  /** Return dates you have set for injured players, by name: YYYY-MM-DD. */
  returns?: Record<string, string | null>
}

export interface Preferences {
  tags: Map<string, PrefTag>
  /** Names that matched nobody: a typo, or a player who has left the league. */
  unresolved: string[]
}

export function resolvePreferences(file: PreferenceFile | null, leagueId: string, index: NameIndex): Preferences {
  const tags = new Map<string, PrefTag>()
  const unresolved: string[] = []
  if (!file) return { tags, unresolved }
  const league = file.leagues?.[leagueId] ?? {}
  // Weakest first, so a name on two lists ends up with the stronger tag.
  for (const tag of ['like', 'avoid', 'never'] as PrefTag[]) {
    for (const name of [...(file[tag] ?? []), ...(league[tag] ?? [])]) {
      const id = index.resolve(name, null)
      if (id) tags.set(id, tag)
      else unresolved.push(name)
    }
  }
  return { tags, unresolved }
}
