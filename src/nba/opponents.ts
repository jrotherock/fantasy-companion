/**
 * How the people in a league draft, from its own history.
 *
 * Three habits, each measured per manager per season:
 *   reach       how far ahead of that season's preseason ADP they take
 *               players in the first eight rounds (positive: earlier)
 *   bigEarly    share of their first six picks who can play centre
 *   guardEarly  share of their first six picks who can play point guard
 *
 * A habit is only worth showing if it holds. So each one is tested at the
 * league level first: does a manager's average over earlier seasons predict
 * the latest one? Football's lesson was that habits which looked real in one
 * draft did not survive another; in basketball's first look, with three
 * seasons, most did not either. A habit is called consistent only where that
 * test passes, and is otherwise shown — if at all — as unproven.
 *
 * Managers are the people (Yahoo nicknames), not team names, which change
 * every year. Seasons Yahoo hides managers in contribute nothing.
 */

export type Metric = 'reach' | 'bigEarly' | 'guardEarly'
export const METRICS: Metric[] = ['reach', 'bigEarly', 'guardEarly']

export interface HistPick {
  pick: number
  round: number
  manager: string | null
  positions: string[]
  adp: number | null
}

export interface HistSeason {
  season: string
  teams: number
  picks: HistPick[]
}

export interface Habit {
  metric: Metric
  text: string
  consistent: boolean
}

export interface ManagerProfile {
  seasons: number
  metrics: Record<Metric, number>
  habits: Habit[]
}

export interface OpponentReport {
  seasons: string[]
  validation: Record<Metric, { managers: number; priorPredictsLast: number; yearToYear: number; pairs: number; consistent: boolean }>
  managers: Record<string, ManagerProfile>
  leagueMean: Record<Metric, number>
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }
export function corr(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys)
  let n = 0, a = 0, b = 0
  for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); a += (xs[i] - mx) ** 2; b += (ys[i] - my) ** 2 }
  return a && b ? n / Math.sqrt(a * b) : 0
}

/** One manager's habits in one season; null where the season cannot say (no ADP for reach). */
export function seasonMetrics(picks: HistPick[]): Partial<Record<Metric, number>> {
  const early = picks.filter((p) => p.round <= 6 && p.positions.length)
  const mid = picks.filter((p) => p.round <= 8 && p.adp != null)
  const out: Partial<Record<Metric, number>> = {}
  if (mid.length >= 4) out.reach = mean(mid.map((p) => p.adp! - p.pick))
  if (early.length >= 4) {
    out.bigEarly = mean(early.map((p) => (p.positions.includes('C') ? 1 : 0)))
    out.guardEarly = mean(early.map((p) => (p.positions.includes('PG') ? 1 : 0)))
  }
  return out
}

/** Thresholds a habit must clear to be called consistent: it has to predict the held-out season. */
const PREDICTS = 0.4
const MIN_MANAGERS = 6

export function analyseOpponents(history: HistSeason[]): OpponentReport {
  const seasons = [...history].sort((a, b) => a.season.localeCompare(b.season))
  const per = new Map<string, Map<string, Partial<Record<Metric, number>>>>()
  for (const s of seasons) {
    const by = new Map<string, HistPick[]>()
    for (const p of s.picks) if (p.manager) by.set(p.manager, [...(by.get(p.manager) ?? []), p])
    per.set(s.season, new Map([...by].map(([m, ps]) => [m, seasonMetrics(ps)])))
  }

  const validation = {} as OpponentReport['validation']
  const leagueMean = {} as Record<Metric, number>
  for (const k of METRICS) {
    // Year to year, across every consecutive pair a manager appears in.
    const xs: number[] = [], ys: number[] = []
    for (let i = 1; i < seasons.length; i++) {
      for (const [m, b] of per.get(seasons[i].season)!) {
        const a = per.get(seasons[i - 1].season)!.get(m)
        if (a?.[k] != null && b[k] != null) { xs.push(a[k]!); ys.push(b[k]!) }
      }
    }
    // The test that matters at a draft: everything before the latest season, against the latest.
    const last = seasons.at(-1)
    const px: number[] = [], py: number[] = []
    if (last) {
      for (const [m, now] of per.get(last.season)!) {
        if (now[k] == null) continue
        const before = seasons.slice(0, -1).map((s) => per.get(s.season)!.get(m)?.[k]).filter((v): v is number => v != null)
        if (before.length) { px.push(mean(before)); py.push(now[k]!) }
      }
    }
    const priorPredictsLast = corr(px, py)
    validation[k] = {
      managers: px.length, priorPredictsLast, yearToYear: corr(xs, ys), pairs: xs.length,
      consistent: px.length >= MIN_MANAGERS && priorPredictsLast >= PREDICTS,
    }
    leagueMean[k] = mean([...per.values()].flatMap((m) => [...m.values()].map((v) => v[k]).filter((v): v is number => v != null)))
  }

  // Profiles: each manager's average, and a habit where they stand well apart from the league.
  const all = new Map<string, Partial<Record<Metric, number>>[]>()
  for (const m of per.values()) for (const [who, v] of m) all.set(who, [...(all.get(who) ?? []), v])
  const spread = Object.fromEntries(METRICS.map((k) => [k, sd([...all.values()].map((vs) => mean(vs.map((v) => v[k]).filter((x): x is number => x != null))))])) as Record<Metric, number>

  const managers: Record<string, ManagerProfile> = {}
  for (const [who, vs] of all) {
    const metrics = Object.fromEntries(METRICS.map((k) => [k, mean(vs.map((v) => v[k]).filter((x): x is number => x != null))])) as Record<Metric, number>
    const habits: Habit[] = []
    if (vs.length >= 3) {
      for (const k of METRICS) {
        const gap = metrics[k] - leagueMean[k]
        if (!spread[k] || Math.abs(gap) < spread[k]) continue
        const consistent = validation[k].consistent
        const text =
          k === 'reach' ? (gap > 0 ? `reaches — about ${Math.round(metrics[k])} picks ahead of ADP` : `waits — takes players about ${Math.round(-metrics[k])} picks after ADP`)
          : k === 'bigEarly' ? `${gap > 0 ? 'loads up on' : 'avoids'} centres early (${Math.round(metrics[k] * 100)}% of first six picks; league ${Math.round(leagueMean[k] * 100)}%)`
          : `${gap > 0 ? 'takes point guards early' : 'leaves point guards'} (${Math.round(metrics[k] * 100)}% of first six; league ${Math.round(leagueMean[k] * 100)}%)`
        habits.push({ metric: k, text, consistent })
      }
    }
    managers[who] = { seasons: vs.length, metrics, habits }
  }
  return { seasons: seasons.map((s) => s.season), validation, managers, leagueMean }
}
