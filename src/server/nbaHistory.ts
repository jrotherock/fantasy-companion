/**
 * A basketball league's draft history, read from the Yahoo API on the server
 * and kept in the state directory. It names league-mates, so it never goes in
 * the repository.
 *
 * Seasons come from two places: Yahoo's renewal chain from the current league,
 * and the older league ids listed in the league's config (read off the league
 * page's season selector, which reaches back to 2005 where the chain stops).
 * A season counts only if Yahoo marks one of its teams as yours: that is the
 * owner's rule, and it also keeps out any league that only shares a name.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './paths.js'
import * as yahooApi from './yahooApi.js'
import { leagueNodes } from './yahooParse.js'
import { parseDraftPlayers, parseDraftResults, parseGameKeys, parseTeams } from '../nba/yahooDraft.js'
import { analyseOpponents, backtestHabits, type HistSeason, type OpponentReport } from '../nba/opponents.js'

export interface StoredHistory {
  leagueId: string
  fetchedAt: number
  seasons: (HistSeason & { leagueKey: string })[]
  skipped: { season: string; leagueKey: string; reason: string }[]
}

const fileOf = (id: string) => join(STATE_DIR, `nba-history-${id}.json`)
const jobs = new Map<string, { started: number; done: boolean; error: string | null; progress: string[] }>()
const reports = new Map<string, { at: number; report: OpponentReport }>()

export function readHistory(leagueId: string): StoredHistory | null {
  return existsSync(fileOf(leagueId)) ? JSON.parse(readFileSync(fileOf(leagueId), 'utf8')) : null
}

/** The analysis, cached until the history is fetched again. */
export function opponentReport(leagueId: string): OpponentReport | null {
  const h = readHistory(leagueId)
  if (!h || !h.seasons.length) return null
  const cached = reports.get(leagueId)
  if (cached && cached.at === h.fetchedAt) return cached.report
  const report = analyseOpponents(h.seasons)
  reports.set(leagueId, { at: h.fetchedAt, report })
  return report
}

async function season(leagueKey: string, label: string): Promise<{ season?: HistSeason & { leagueKey: string }; skip?: string }> {
  const teams = parseTeams(await yahooApi.call(`league/${leagueKey}/teams`))
  if (!teams.some((t) => t.mine)) return { skip: 'you had no team in it' }
  const manager = new Map(teams.map((t) => [t.key, t.manager]))
  const picks = parseDraftResults(await yahooApi.call(`league/${leagueKey}/draftresults`))
  if (!picks.length) return { skip: 'no draft results' }
  const info = new Map<string, { positions: string[]; adp: number | null }>()
  const keys = picks.map((p) => p.playerKey)
  for (let i = 0; i < keys.length; i += 25) {
    for (const [k, v] of parseDraftPlayers(await yahooApi.call(`league/${leagueKey}/players;player_keys=${keys.slice(i, i + 25).join(',')}/draft_analysis`))) info.set(k, v)
  }
  return {
    season: {
      season: label, leagueKey, teams: teams.length,
      picks: picks.map((p) => ({ pick: p.overall, round: p.round, manager: manager.get(p.teamKey) ?? null, positions: info.get(p.playerKey)?.positions ?? [], adp: info.get(p.playerKey)?.adp ?? null })),
    },
  }
}

/** Reads every season the owner played in. Slow and run once; the result is stored. */
export async function fetchHistory(leagueId: string, currentKey: string, extra: { season: string; leagueId: string }[]) {
  if (jobs.get(leagueId) && !jobs.get(leagueId)!.done) return
  const job = { started: Date.now(), done: false, error: null as string | null, progress: [] as string[] }
  jobs.set(leagueId, job)
  try {
    const targets = new Map<string, string>()
    // The renewal chain, newest first, excluding the season not yet drafted.
    let key: string | null = currentKey
    let first = true
    while (key) {
      const node: { meta: Record<string, any> } | undefined = leagueNodes(await yahooApi.call(`league/${key}`))[0]
      if (!node) break
      if (!first) targets.set(String(node.meta.season), key)
      first = false
      key = node.meta.renew ? String(node.meta.renew).replace('_', '.l.') : null
    }
    // Older seasons from the config, which need that year's game key.
    const missing = extra.filter((e) => !targets.has(e.season))
    if (missing.length) {
      const games = parseGameKeys(await yahooApi.call(`games;game_codes=nba;seasons=${missing.map((e) => e.season).join(',')}`))
      for (const e of missing) if (games.has(e.season)) targets.set(e.season, `${games.get(e.season)}.l.${e.leagueId}`)
    }
    const out: StoredHistory = { leagueId, fetchedAt: Date.now(), seasons: [], skipped: [] }
    for (const [label, k] of [...targets].sort((a, b) => b[0].localeCompare(a[0]))) {
      try {
        const r = await season(k, label)
        if (r.season) out.seasons.push(r.season)
        else out.skipped.push({ season: label, leagueKey: k, reason: r.skip! })
        job.progress.push(`${label}: ${r.season ? `${r.season.picks.length} picks` : r.skip}`)
      } catch (e) {
        out.skipped.push({ season: label, leagueKey: k, reason: `Yahoo would not answer (${(e as Error).message.slice(0, 80)})` })
        job.progress.push(`${label}: error`)
        if ((e as yahooApi.YahooError).kind === 'budget' || (e as yahooApi.YahooError).kind === 'rate-limited') break
      }
    }
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(fileOf(leagueId), JSON.stringify(out))
  } catch (e) {
    job.error = (e as Error).message
  } finally {
    job.done = true
  }
}

export function historyStatus(leagueId: string) {
  const h = readHistory(leagueId)
  return {
    job: jobs.get(leagueId) ?? null,
    fetchedAt: h?.fetchedAt ?? null,
    seasons: h?.seasons.map((s) => ({ season: s.season, teams: s.teams, picks: s.picks.length, managers: new Set(s.picks.map((p) => p.manager).filter(Boolean)).size })) ?? [],
    skipped: h?.skipped ?? [],
    report: opponentReport(leagueId),
  }
}

/** Whether this league's habits predict its picks better than ADP alone, season by season. */
export function backtest(leagueId: string) {
  const h = readHistory(leagueId)
  return h ? backtestHabits(h.seasons) : null
}
