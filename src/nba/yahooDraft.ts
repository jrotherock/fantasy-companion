/**
 * Reading a basketball draft from the Yahoo API. Pure: takes Yahoo's answers,
 * returns picks and seats, so it can be tested against what Yahoo really sent.
 *
 * Shapes, from real answers on 2026-10-02:
 *   league/{key}/draftresults  draft_result { pick (overall), round, team_key, player_key }
 *   league/{key}/teams         team [... { name } ... { draft_position } ... { is_owned_by_current_login }]
 * draft_position is empty until the commissioner's order is set. The results
 * page lists teams in id order before then, which is not the draft order.
 */
import { flat, leagueNodes, list, num, parsePlayer } from '../server/yahooParse.js'

export interface ApiPick {
  overall: number
  round: number
  teamKey: string
  playerKey: string
}

export interface ApiTeam {
  key: string
  name: string
  draftPosition: number | null
  mine: boolean
  /** The manager's Yahoo nickname: the person, who keeps it while team names change every year. */
  manager: string | null
}

/** The manager in each seat, in draft order, once every seat is set. */
export function draftManagers(teams: ApiTeam[]): (string | null)[] {
  if (!teams.length || teams.some((t) => t.draftPosition == null)) return []
  return [...teams].sort((a, b) => a.draftPosition! - b.draftPosition!).map((t) => t.manager)
}

export function parseDraftResults(json: any): ApiPick[] {
  const node = leagueNodes(json)[0]
  if (!node) return []
  return list(node.body.draft_results)
    .map((x: any) => x?.draft_result)
    .filter((r: any) => r && r.player_key)
    .map((r: any) => ({ overall: num(r.pick)!, round: num(r.round)!, teamKey: String(r.team_key), playerKey: String(r.player_key) }))
    .filter((r) => r.overall != null && r.round != null)
    .sort((a, b) => a.overall - b.overall)
}

export function parseTeams(json: any): ApiTeam[] {
  const node = leagueNodes(json)[0]
  if (!node) return []
  return list(node.body.teams).map((t: any) => {
    const m = flat(t?.team?.[0])
    const nick = m.managers?.[0]?.manager?.nickname ?? flat(m.managers)?.manager?.nickname ?? null
    return {
      key: String(m.team_key), name: String(m.name ?? ''), draftPosition: num(m.draft_position),
      mine: Number(m.is_owned_by_current_login ?? 0) === 1,
      // Yahoo hides other managers' identities in some seasons; a hidden one is nobody we can follow.
      manager: nick && nick !== '--hidden--' ? String(nick) : null,
    }
  })
}

/** Team names in draft order, but only once every team has a seat; a partial order is not an order. */
export function draftOrder(teams: ApiTeam[]): string[] {
  if (!teams.length || teams.some((t) => t.draftPosition == null)) return []
  return [...teams].sort((a, b) => a.draftPosition! - b.draftPosition!).map((t) => t.name)
}

export function parsePlayerNames(json: any): Map<string, { name: string; team: string | null }> {
  const node = leagueNodes(json)[0]
  const out = new Map<string, { name: string; team: string | null }>()
  for (const x of list(node?.body.players)) {
    const p = parsePlayer(x?.player)
    if (p) out.set(p.key, { name: p.name, team: p.team })
  }
  return out
}

export function draftStatus(json: any): string | null {
  return leagueNodes(json)[0]?.meta.draft_status ?? null
}

/** Every drafted player's position and that season's preseason ADP, from a players;player_keys=…/draft_analysis answer. */
export function parseDraftPlayers(json: any): Map<string, { name: string; positions: string[]; adp: number | null }> {
  const node = leagueNodes(json)[0]
  const out = new Map<string, { name: string; positions: string[]; adp: number | null }>()
  for (const x of list(node?.body.players)) {
    const p = x?.player
    if (!Array.isArray(p)) continue
    const m = flat(p[0])
    const da = flat(flat(p.slice(1)).draft_analysis)
    out.set(String(m.player_key), {
      name: String(m.name?.full ?? ''),
      positions: String(m.display_position ?? '').split(',').filter(Boolean),
      adp: num(da.preseason_average_pick) ?? num(da.average_pick),
    })
  }
  return out
}

/** Season → game key, from games;game_codes=nba;seasons=… */
export function parseGameKeys(json: any): Map<string, string> {
  const out = new Map<string, string>()
  for (const x of list(json?.fantasy_content?.games)) {
    const m = flat(x?.game)
    if (m.season && m.game_key) out.set(String(m.season), String(m.game_key))
  }
  return out
}
