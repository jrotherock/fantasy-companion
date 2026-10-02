/**
 * One basketball draft: who has gone where, which seat is mine, and what I have
 * decided. No I/O — the server persists it and the extension feeds it.
 *
 * Yahoo's results page is the authority for every pick it shows. Manual entry
 * is always live, because a sensor can drop out mid-draft; a manual pick is
 * kept until Yahoo reports that slot, and then Yahoo's answer replaces it. A
 * manual pick of a player Yahoo has since placed somewhere else is dropped
 * rather than left to count him twice.
 */
import type { Cat } from './value.js'
import type { NameIndex } from './join.js'

export interface DraftPick {
  overall: number
  playerId: string
  name: string
  source: 'yahoo' | 'manual'
  /** Which Yahoo reader reported it: the API on the server, or the results page through the extension. */
  via?: 'api' | 'page'
  /** The team that made it, where Yahoo says. */
  manager?: string
}

export interface YahooRow {
  round: number
  pickInRound: number
  /** Already resolved, when the source knows Yahoo's id for the player. */
  playerId?: string
  name: string
  team?: string
  pos?: string
  manager?: string
}

export interface FeedItem {
  at: number
  kind: string
  text: string
}

export interface StoredDraft {
  leagueId: string
  picks: DraftPick[]
  /** My seat in round one, 1-based. From Yahoo's order when it has one. */
  slot: number | null
  slotSource: 'yahoo' | 'manual' | null
  /** Round-one order by team name, as the results page lists it before and during the draft. */
  order: string[]
  locks: Cat[]
  feed: FeedItem[]
  /** The advice's first choice at each pick I was on the clock for, keyed by overall pick — for the review. */
  advised?: Record<number, string>
  /**
   * The whole advice at each of my turns, for comparing mocks: what was on
   * offer, how each scored, and what I had locked. Only turns the screen was
   * open for are recorded.
   */
  turns?: Record<number, Turn>
  sensor: { at: number | null; ok: boolean; error: string | null; unresolved: string[]; source?: 'api' | 'page' }
}

export interface Turn {
  at: number
  advice: { id: string; score: number; survives: number; canWait: boolean }[]
  locks: Cat[]
  stage: 'open' | 'leaning' | 'firm' | null
}

export function emptyDraft(leagueId: string): StoredDraft {
  return { leagueId, picks: [], slot: null, slotSource: null, order: [], locks: [], feed: [], sensor: { at: null, ok: false, error: null, unresolved: [] } }
}

/** Teams in the draft: Yahoo's order once it is posted, the league's setting until then. */
export function teamsIn(d: StoredDraft, configured: number): number {
  return d.order.length || configured
}

/**
 * `order` is round one's teams in draft order. From the API it is only sent
 * once Yahoo has set every seat. The results page lists teams in id order
 * until the draft starts, which is not the draft order, so a page's order is
 * trusted only once it carries picks.
 */
export function ingestYahoo(
  d: StoredDraft, rows: YahooRow[], order: string[], myTeamName: string, configuredTeams: number, index: NameIndex, now = Date.now(),
  source: 'api' | 'page' = 'page',
): { accepted: number; unresolved: string[] } {
  if (order.length && (source === 'api' || rows.length > 0)) d.order = order
  // A mock has no name of mine to look for, and an empty name must not match an empty row.
  const mine = myTeamName.trim() ? d.order.findIndex((t) => t.trim() === myTeamName.trim()) : -1
  if (mine >= 0 && (d.slot !== mine + 1 || d.slotSource !== 'yahoo')) {
    if (d.slot != null && d.slot !== mine + 1) d.feed.push({ at: now, kind: 'slot', text: `Yahoo moved your seat to ${mine + 1}` })
    d.slot = mine + 1
    d.slotSource = 'yahoo'
  }
  // An empty snapshot is a reader that lost sight of the board, not a draft
  // that was undone; football learned that one the hard way.
  if (!rows.length) {
    d.sensor = { at: now, ok: true, error: null, unresolved: [], source }
    return { accepted: 0, unresolved: [] }
  }
  const teams = teamsIn(d, configuredTeams)
  const unresolved: string[] = []
  const fromYahoo = new Map<number, DraftPick>()
  for (const r of rows) {
    const id = r.playerId ?? index.resolve(r.name, r.team?.trim() || null)
    if (!id) { unresolved.push(r.name); continue }
    const overall = (r.round - 1) * teams + r.pickInRound
    fromYahoo.set(overall, { overall, playerId: id, name: r.name, source: 'yahoo', via: source, manager: r.manager })
  }
  const yahooIds = new Set([...fromYahoo.values()].map((p) => p.playerId))
  /*
   * Two readers report the same draft and one is usually a pick behind. Each
   * snapshot speaks for its own reader only: a pick this reader no longer
   * reports is retracted (Yahoo undid it), but a pick the other reader has
   * and this one has not reached yet stays. Anything this snapshot places
   * replaces whatever sat at that pick, or held that player.
   */
  const kept = d.picks.filter((p) =>
    !(p.source === 'yahoo' && (p.via ?? 'page') === source) && !fromYahoo.has(p.overall) && !yahooIds.has(p.playerId))
  d.picks = [...fromYahoo.values(), ...kept].sort((a, b) => a.overall - b.overall)
  d.sensor = { at: now, ok: true, error: null, unresolved, source }
  return { accepted: fromYahoo.size, unresolved }
}

export function nextOverall(d: StoredDraft): number {
  return (d.picks.at(-1)?.overall ?? 0) + 1
}

export function addManual(d: StoredDraft, playerId: string, name: string): DraftPick | null {
  if (d.picks.some((p) => p.playerId === playerId)) return null
  const pick: DraftPick = { overall: nextOverall(d), playerId, name, source: 'manual' }
  d.picks.push(pick)
  return pick
}

/** Takes back the most recent manual pick. Yahoo's picks are Yahoo's to change. */
export function undoManual(d: StoredDraft): DraftPick | null {
  for (let i = d.picks.length - 1; i >= 0; i--) {
    if (d.picks[i].source === 'manual') return d.picks.splice(i, 1)[0]
  }
  return null
}

export function setSlot(d: StoredDraft, slot: number | null) {
  d.slot = slot
  d.slotSource = slot == null ? null : 'manual'
}

export function setLocks(d: StoredDraft, locks: Cat[]) {
  d.locks = [...new Set(locks)]
}

/** Picks made from my seat, in order. */
export function myPicks(d: StoredDraft, teams: number, slotFor: (overall: number, teams: number) => number): DraftPick[] {
  if (d.slot == null) return []
  return d.picks.filter((p) => slotFor(p.overall, teams) === d.slot)
}
