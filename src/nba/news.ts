/**
 * Basketball news, sorted by whose player it is.
 *
 * Football's news screen groups by what you would do about it: a hole to fill,
 * an opening to take, a riser to watch. Basketball's needs the same groups and
 * moves faster: designations change every afternoon before tip, and a starter's
 * absence hands minutes to a teammate the same night. So:
 *   - status changes, read by diffing designations between polls;
 *   - minutes trends from the game log (last five games against the season);
 *   - openings: a rotation player out, and the free agents on his team who play
 *     his positions.
 * Never-list players are left out of everything (his rule: never anywhere in
 * the basketball app but the draft board).
 */
import type { Context, Snapshot } from './inseason.js'
import type { Designation } from './outlook.js'

export interface StatusEvent {
  id: string
  at: number
  from: Designation
  to: Designation
}

const SEVERITY: Record<Designation, number> = { healthy: 0, probable: 1, questionable: 2, doubtful: 3, out: 4, suspended: 4, injured: 5, inactive: 5 }

/** What changed between two polls' designations. A player absent from either is not news. */
export function diffStatus(prev: Record<string, Designation>, cur: Record<string, Designation>, at: number): StatusEvent[] {
  const out: StatusEvent[] = []
  for (const [id, to] of Object.entries(cur)) {
    const from = prev[id]
    if (from == null || from === to) continue
    out.push({ id, at, from, to })
  }
  return out
}

export type Whose = 'mine' | 'opponent' | 'free' | 'other'

export interface NewsItem {
  key: string
  at: number | null
  playerId: string
  name: string
  team: string | null
  whose: Whose
  kind: 'worse' | 'better' | 'minutes-up' | 'minutes-down' | 'opening'
  headline: string
  detail: string
  /** For ordering: whose player first, then how much it matters. */
  weight: number
}

const WHOSE_WEIGHT: Record<Whose, number> = { mine: 3, opponent: 2, free: 1, other: 0 }

const words: Record<Designation, string> = {
  healthy: 'cleared', probable: 'probable', questionable: 'questionable', doubtful: 'doubtful',
  out: 'out', suspended: 'suspended', injured: 'injured', inactive: 'inactive',
}

export function leagueNews(ctx: Context, snap: Snapshot, myTeamId: string, events: StatusEvent[], opponentId: string | null): NewsItem[] {
  const owner = new Map<string, string>()
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) owner.set(id, r.team.id) }
  const whose = (id: string): Whose => {
    const o = owner.get(id)
    return o === myTeamId ? 'mine' : o && o === opponentId ? 'opponent' : o ? 'other' : 'free'
  }
  const never = ctx.world.never
  const items: NewsItem[] = []
  const name = (id: string) => ctx.byId.get(id)?.name ?? id
  const team = (id: string) => ctx.byId.get(id)?.team ?? null
  // Fantasy-relevant only: a free agent nobody would start is not news.
  const relevant = (id: string) => {
    const p = ctx.byId.get(id)
    return !!p && (owner.has(id) || (p.projection?.perGame.min ?? 0) >= 18)
  }

  for (const e of events) {
    if (never.has(e.id) || !relevant(e.id)) continue
    const w = whose(e.id)
    const worse = SEVERITY[e.to] > SEVERITY[e.from]
    const r = ctx.returnOf(e.id)
    items.push({
      key: `status:${e.id}:${e.at}`, at: e.at, playerId: e.id, name: name(e.id), team: team(e.id), whose: w,
      kind: worse ? 'worse' : 'better',
      headline: `${name(e.id)} ${e.to === 'healthy' ? 'is cleared to play' : `is ${words[e.to]}`}`,
      detail: [`was ${words[e.from]}`, r.text].filter(Boolean).join(' · '),
      weight: WHOSE_WEIGHT[w] * 10 + (worse ? SEVERITY[e.to] : 1),
    })
  }

  // Minutes: last five games against his season. One week of minutes is noise
  // in blowouts, so the bar is five minutes on a player who already plays.
  for (const p of ctx.byId.values()) {
    if (never.has(p.id) || p.recentMin == null || p.seasonMin == null || p.formGames < 6) continue
    const d = p.recentMin - p.seasonMin
    const w = whose(p.id)
    if (d >= 5 && p.recentMin >= 24 && (w === 'free' || w === 'mine')) {
      items.push({
        key: `min-up:${p.id}`, at: null, playerId: p.id, name: p.name, team: p.team, whose: w, kind: 'minutes-up',
        headline: `${p.name}: ${p.recentMin.toFixed(0)} minutes over his last five`,
        detail: `${p.seasonMin.toFixed(0)} a game over the season`,
        weight: WHOSE_WEIGHT[w] * 10 + Math.min(9, d / 2),
      })
    } else if (d <= -6 && w === 'mine') {
      items.push({
        key: `min-down:${p.id}`, at: null, playerId: p.id, name: p.name, team: p.team, whose: w, kind: 'minutes-down',
        headline: `${p.name}: ${p.recentMin.toFixed(0)} minutes over his last five`,
        detail: `down from ${p.seasonMin.toFixed(0)} a game`,
        weight: WHOSE_WEIGHT[w] * 10 + Math.min(9, -d / 2),
      })
    }
  }

  // Openings: a rotation player out, and the free agents on his team at his positions.
  for (const p of ctx.byId.values()) {
    const d = ctx.designation(p.id)
    if (!['out', 'injured', 'suspended'].includes(d) || (p.projection?.perGame.min ?? 0) < 28 || !p.team) continue
    const mates = [...ctx.byId.values()].filter((m) =>
      m.team === p.team && m.id !== p.id && whose(m.id) === 'free' && !never.has(m.id)
      && ctx.designation(m.id) === 'healthy'
      && (m.projection?.perGame.min ?? 0) >= 10 && (m.projection?.perGame.min ?? 0) <= 27
      && m.positions.some((x) => p.positions.includes(x)))
      .sort((a, b) => (b.projection?.perGame.min ?? 0) - (a.projection?.perGame.min ?? 0))
      .slice(0, 2)
    for (const m of mates) {
      items.push({
        key: `opening:${p.id}:${m.id}`, at: null, playerId: m.id, name: m.name, team: m.team, whose: 'free', kind: 'opening',
        headline: `${p.name} is ${words[d]} — ${m.name} plays his minutes`,
        detail: `${m.name} (${m.positions.join('/')}) is a free agent; ${(m.projection?.perGame.min ?? 0).toFixed(0)} minutes a game usually`,
        weight: WHOSE_WEIGHT.free * 10 + 5,
      })
    }
  }

  return items.sort((a, b) => b.weight - a.weight || (b.at ?? 0) - (a.at ?? 0))
}
