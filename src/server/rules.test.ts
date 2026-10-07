import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, PLANNING, type Snapshot } from './rules.js'

const FRI = new Date(2026, 8, 4, 9, 0, 0).getTime()
const player = (o: Partial<Snapshot['players'][0]> & { name: string }) => ({
  id: o.name, pos: 'RB', starter: true, injuryStatus: null,
  projected: 10, kickoff: 'Sun 1:25 pm', ...o,
})
const snap = (o: Partial<Snapshot>): Snapshot => ({
  leagueId: 'l', label: 'Steward', link: null, players: [], advice: null, ...o,
})

test('a ruled-out starter always fires, and carries his own kickoff', () => {
  const a = evaluate(snap({ players: [player({ name: 'Henry', injuryStatus: 'OUT' })] }), FRI)
  assert.equal(a.length, 1)
  assert.equal(a[0].rule, 'starter-out')
  assert.ok(a[0].consequence >= 80, 'must clear the always-fire floor')
  assert.equal(new Date(a[0].deadline!).getDay(), 0)
})

test('a ruled-out bench player is not news', () => {
  const a = evaluate(snap({
    players: [player({ name: 'Washington', starter: false, injuryStatus: 'IR' })],
  }), FRI)
  assert.equal(a.length, 0)
})

test('points on the bench fire only near lock and only when material', () => {
  const players = [player({ name: 'Watson' })]
  const big = { gain: 8, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Watson' }, slot: 'W/R/T', gain: 8 }] }
  // Two days out, nothing to do yet.
  assert.equal(evaluate(snap({ players, advice: big }), FRI).length, 0)
  // Sunday morning, same fact, now actionable.
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const near = evaluate(snap({ players, advice: big }), SUN)
  assert.equal(near.length, 1)
  assert.equal(near[0].rule, 'lineup-gain')
  // A single point never interrupts.
  assert.equal(evaluate(snap({ players, advice: { gain: 1, swaps: [] } }), SUN).length, 0)
})

test('a lineup nudge never outranks a ruled-out starter', () => {
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const a = evaluate(snap({
    players: [player({ name: 'Henry', injuryStatus: 'OUT' })],
    advice: { gain: 30, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Henry' }, slot: 'RB', gain: 30 }] },
  }), SUN)
  const out = a.find((x) => x.rule === 'starter-out')!
  const gain = a.find((x) => x.rule === 'lineup-gain')!
  assert.ok(out.consequence > gain.consequence)
})

test('questionable waits until three hours before kickoff', () => {
  const players = [player({ name: 'Waddle', injuryStatus: 'Q', kickoff: 'Sun 1:25 pm' })]
  const SUN_MORNING = new Date(2026, 8, 6, 8, 0, 0).getTime()
  assert.equal(evaluate(snap({ players }), SUN_MORNING).length, 0, 'five hours out is a note')
  const SUN_NEAR = new Date(2026, 8, 6, 11, 0, 0).getTime()
  const a = evaluate(snap({ players }), SUN_NEAR)
  assert.equal(a.length, 1)
  assert.equal(a[0].rule, 'starter-questionable')
})

test('every alert carries a deadline, or it is a note not an alert', () => {
  const SUN = new Date(2026, 8, 6, 11, 0, 0).getTime()
  const all = evaluate(snap({
    players: [player({ name: 'Henry', injuryStatus: 'OUT' }), player({ name: 'Waddle', injuryStatus: 'Q' })],
    advice: { gain: 9, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Henry' }, slot: 'RB', gain: 9 }] },
  }), SUN)
  assert.ok(all.length >= 3)
  assert.ok(all.every((x) => x.deadline != null))
})

test('a bye a week out is planning, and does not mark a league today', () => {
  /*
   * The home screen counts what needs you now. A bye eleven days away is a
   * thing to carry into the next waiver run — it still shows on the league's
   * own screen and still earns a notification near its deadline, but marking a
   * tile for it makes "three things in two leagues" mean less every time it is
   * true of something nobody can act on yet.
   */
  assert.ok(PLANNING.has('bye-ahead'))
  for (const r of ['starter-out', 'starter-questionable', 'lineup-gain', 'waivers-closing']) {
    assert.ok(!PLANNING.has(r), `${r} is a thing to do now, not to plan for`)
  }
})

test('waivers close when they close, not always "tonight"', () => {
  /*
   * The six-hour gate is on the notification; the screens ask for this ungated
   * so the money and the hole stay visible all week. On those it announced a
   * deadline six days out as though it were this evening.
   */
  const base = {
    assumedDay: 'Tuesday', budget: 200, spent: 0,
    holes: [{ slot: 'TE', reason: 'nobody who can play', severity: 95 }],
    targets: [{ name: 'A Tight End', pos: 'TE', fills: 'TE', projected: 8 }],
  }
  const now = Date.UTC(2026, 9, 7, 19, 0) // a Wednesday evening
  const said = (inMs: number) =>
    evaluate(snap({ waivers: { ...base, clearsAt: now + inMs } }), now, { display: true })
      .find((a) => a.rule === 'waivers-closing')!.headline
  assert.match(said(3 * 3600_000), /close tonight/)
  assert.match(said(20 * 3600_000), /close tomorrow/)
  assert.match(said(6 * 86400_000), /close on Tuesday/, 'six days out is not tonight')
})

test('waivers need money, a hole and somebody to fix it — all three', () => {
  const SOON = Date.now() + 2 * 60 * 60 * 1000
  const full = {
    clearsAt: SOON, assumedDay: 'Tuesday', budget: 200, spent: 0,
    holes: [{ slot: 'TE', reason: 'nobody who can play', severity: 95 }],
    targets: [{ name: 'A Tight End', pos: 'TE', fills: 'TE', projected: 8 }],
  }
  const fire = evaluate(snap({ waivers: full }), Date.now())
  assert.equal(fire.length, 1)
  assert.equal(fire[0].rule, 'waivers-closing')

  // Remove any one leg and it stays quiet.
  assert.equal(evaluate(snap({ waivers: { ...full, spent: 200 } }), Date.now()).length, 0)
  assert.equal(evaluate(snap({ waivers: { ...full, holes: [] } }), Date.now()).length, 0)
  assert.equal(evaluate(snap({ waivers: { ...full, targets: [] } }), Date.now()).length, 0)
})

test('waivers do not interrupt two days early', () => {
  const FAR = Date.now() + 48 * 60 * 60 * 1000
  assert.equal(evaluate(snap({ waivers: {
    clearsAt: FAR, assumedDay: 'Tuesday', budget: 200, spent: 0,
    holes: [{ slot: 'TE', reason: 'x', severity: 95 }],
    targets: [{ name: 'T', pos: 'TE', fills: 'TE', projected: 8 }],
  } }), Date.now()).length, 0)
})

test('a waiver alert never outranks a ruled-out starter', () => {
  const SOON = Date.now() + 2 * 60 * 60 * 1000
  const a = evaluate(snap({
    players: [player({ name: 'Henry', injuryStatus: 'OUT' })],
    waivers: { clearsAt: SOON, assumedDay: 'Tue', budget: 200, spent: 0,
      holes: [{ slot: 'TE', reason: 'x', severity: 100 }],
      targets: [{ name: 'T', pos: 'TE', fills: 'TE', projected: 8 }] },
  }), Date.now())
  const out = a.find((x) => x.rule === 'starter-out')!
  const wav = a.find((x) => x.rule === 'waivers-closing')!
  assert.ok(out.consequence > wav.consequence)
})

test('a draft warns half an hour out, and not before', () => {
  const at = Date.now() + 90 * 60 * 1000
  const league = { leagueId: 'g', label: 'Harker Football Green', link: null,
    players: [], advice: null, draft: { at, slotSet: false, mySlot: null } }
  assert.equal(evaluate(snap(league as any), Date.now()).length, 0,
    'ninety minutes out is not yet news')

  const near = Date.now() + 20 * 60 * 1000
  const a = evaluate(snap({ ...league, draft: { at: near, slotSet: false, mySlot: null } } as any), Date.now())
  assert.equal(a.length, 1)
  assert.equal(a[0].rule, 'draft-imminent')
  assert.match(a[0].headline, /drafts in \d+ minutes/)
})

test('a missed draft cannot be undone, so it is never rationed', () => {
  const near = Date.now() + 10 * 60 * 1000
  const a = evaluate(snap({ leagueId: 'g', label: 'Green', link: null, players: [], advice: null,
    draft: { at: near, slotSet: true, mySlot: 8 } } as any), Date.now())
  assert.ok(a[0].consequence >= 80, 'must clear the always-fire floor')
  assert.match(a[0].detail, /slot 8/)
})

test('a draft already begun is not announced as upcoming', () => {
  const past = Date.now() - 60 * 1000
  assert.equal(evaluate(snap({ leagueId: 'g', label: 'Green', link: null, players: [], advice: null,
    draft: { at: past, slotSet: true, mySlot: 8 } } as any), Date.now()).length, 0)
})

test('a stale roster is only worth saying before the games', () => {
  /*
   * Anchored to the same clock as the evaluation, not to the real one. The
   * capture was `Date.now() - 4 days` against evaluation times fixed to a
   * particular September weekend, so the gap between them shrank as the
   * calendar advanced and the test began failing on its own once the date
   * passed — nothing to do with the code under test.
   */
  const FRI = new Date(2026, 8, 4, 9, 0, 0).getTime()
  const old = FRI - 4 * 24 * 60 * 60 * 1000
  const base = { players: [player({ name: 'Nix', kickoff: 'Sun 1:25 pm' })], capturedAt: old }
  assert.equal(evaluate(snap(base as any), FRI).filter((a) => a.rule === 'roster-stale').length, 0,
    'two days out there is time; it is not news yet')
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const a = evaluate(snap(base as any), SUN).find((x) => x.rule === 'roster-stale')!
  assert.ok(a, 'the morning of, it is')
  assert.match(a.headline, /has not been read for \d+ days/)
})

test('a fresh roster is never called stale', () => {
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  assert.equal(evaluate(snap({
    players: [player({ name: 'Nix' })], capturedAt: SUN - 3600000,
  } as any), SUN).filter((a) => a.rule === 'roster-stale').length, 0)
})

test('a bye warns the week before, not during', () => {
  const byes = [{ week: 7, away: 3, shortfalls: [{ slot: 'QB' }] }]
  const waivers = { clearsAt: Date.now() + 86400000, assumedDay: 'Tue', budget: 200, spent: 0,
    holes: [], targets: [] }
  const early = evaluate(snap({ byes, week: 6, waivers } as any), Date.now())
    .find((a) => a.rule === 'bye-ahead')
  assert.ok(early, 'the week before is when there is still somebody to claim')
  assert.match(early!.headline, /Week 7 leaves you short at QB/)
  assert.equal(evaluate(snap({ byes, week: 4, waivers } as any), Date.now())
    .filter((a) => a.rule === 'bye-ahead').length, 0, 'three weeks out is too early to act')
  assert.equal(evaluate(snap({ byes, week: 7, waivers } as any), Date.now())
    .filter((a) => a.rule === 'bye-ahead').length, 0, 'during the week it is too late')
})

test('only a real move in role is worth mentioning', () => {
  const roles = [
    { name: 'Big Mover', pos: 'WR', snapTrend: 0.22, targetTrend: 0.04, owned: true },
    { name: 'Barely Moved', pos: 'WR', snapTrend: 0.03, targetTrend: 0.01, owned: false },
  ]
  const out = evaluate(snap({ roles } as any), Date.now()).filter((a) => a.rule === 'role-changing')
  assert.equal(out.length, 1)
  assert.match(out[0].headline, /Big Mover/)
  assert.ok(out[0].consequence < 80, 'never worth waking anyone for')
})

test('the matchup alerts on the crossing, not on the wobble', () => {
  const behindAllAlong = { mine: 90, theirs: 100, wasAhead: false }
  assert.equal(evaluate(snap({ matchup: behindAllAlong } as any), Date.now())
    .filter((a) => a.rule === 'matchup-flipped').length, 0, 'behind and staying behind is not news')
  const justFlipped = { mine: 90, theirs: 100, wasAhead: true }
  const a = evaluate(snap({ matchup: justFlipped } as any), Date.now())
    .find((x) => x.rule === 'matchup-flipped')!
  assert.ok(a)
  assert.match(a.detail, /you were ahead at the last look/)
})

test('the schedule\'s kickoff wins over a stale captured one', () => {
  /*
   * Nate Landman plays on Monday night. The Yahoo sensor still held week one's
   * "Thu 5:35 pm" for him, and the card gave a Monday-night linebacker a
   * Thursday deadline.
   */
  const MON_NIGHT = new Date(2026, 8, 7, 20, 15, 0).getTime()
  const a = evaluate(snap({
    players: [player({ name: 'Landman', injuryStatus: 'Q', kickoff: 'Thu 5:35 pm', kickoffAt: MON_NIGHT })],
  }), FRI, { display: true })
  assert.equal(a[0].rule, 'starter-questionable')
  assert.equal(a[0].deadline, MON_NIGHT)
})

test('a league that prints no kickoff still hears about a questionable starter near it', () => {
  // Sleeper prints no kickoff text. With the schedule's, the three-hour warning
  // reaches it like any other league.
  const SUN = new Date(2026, 8, 6, 11, 0, 0).getTime()
  const a = evaluate(snap({
    players: [player({ name: 'Swift', injuryStatus: 'Q', kickoff: null, kickoffAt: SUN + 2 * 3600_000 })],
  }), SUN)
  assert.equal(a.length, 1)
  assert.equal(a[0].consequence, 50)
  assert.match(a[0].detail, /under three hours/)
})

test('a game already played is not the next lock', () => {
  // Thursday's kickoff is a date in the past by Sunday, and the bench-points
  // alert waits for the next lock, not the last one.
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const THU = new Date(2026, 8, 3, 20, 15, 0).getTime()
  const big = { gain: 8, swaps: [{ in: { name: 'Lloyd' }, out: { name: 'Watson' }, slot: 'W/R/T', gain: 8 }] }
  const a = evaluate(snap({
    players: [player({ name: 'Early', kickoff: null, kickoffAt: THU }), player({ name: 'Watson', kickoff: null, kickoffAt: SUN + 4 * 3600_000 })],
    advice: big,
  }), SUN)
  assert.equal(a.find((x) => x.rule === 'lineup-gain')?.deadline, SUN + 4 * 3600_000)
})

test('a swap against a projection nobody read is a question, not points', () => {
  /*
   * "14.2 points on your bench" over a choice between a projected linebacker
   * and a blank: the man coming out had no projection at all, and his absence
   * was counted as the whole of the gain.
   */
  const SUN = new Date(2026, 8, 6, 9, 0, 0).getTime()
  const blind = {
    gain: 14.2, decisive: 0,
    swaps: [{
      in: { name: 'Landman', projected: 14.2 }, out: { name: 'Bush' },
      slot: 'LB', gain: 14.2, unknownOut: true,
    }],
  }
  const a = evaluate(snap({ players: [player({ name: 'Bush' })], advice: blind }), SUN)
  const gain = a.find((x) => x.rule === 'lineup-gain')!
  assert.match(gain.headline, /start\/sit worth checking/i)
  assert.doesNotMatch(gain.headline, /14\.2 points/)
  assert.match(gain.detail, /no projection was read for Bush/)
  assert.ok(gain.consequence < 50, 'a question ranks below a measured gain')
})
