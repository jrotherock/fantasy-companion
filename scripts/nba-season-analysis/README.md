# Public league (231557): the season played out against the real schedule

One-off analysis scripts from 2026-10-10. Each reads a snapshot JSON (`weeks`: Yahoo's
weeks 1–19 with each week's pairings; `rosters`: every team's Yahoo player ids, `i` = on IL)
and plays out every regular-season week, night by night, with `projectWeek`'s seating and
`categoryWeek`'s odds. Projections come from `data/nba/players.json`.

    npx tsx scripts/nba-season-analysis/season.ts scripts/nba-season-analysis/<snapshot dir>

- `season.ts`: week-by-week odds against each opponent; the best add (and drop) across weeks 1–19.
- `wk1.ts`: the best single and double streams for week 1, and stream-then-return paths.
- `dd.ts`: DeRozan paths (now vs after a week-1 stream; which drop).
- `fvv.ts`: starts per player and average category odds, now vs DeRozan for VanVleet.

The scripts read `<dir>/sched.json`. To refresh: through the signed-in app in Chrome, read
`/api/yahoo/raw?path=league/478.l.231557/scoreboard;week=N` (N = 1..19) for pairings, and
`league/478.l.231557/teams/roster` for rosters, in the format of `2026-10-10/sched.json`.
Refresh projections first with `npx tsx scripts/nba-data.ts` if they are stale.
