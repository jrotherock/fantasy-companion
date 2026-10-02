# Fantasy Companion

```bash
./run.sh
```

Starts both apps on one port, detached, so closing the terminal does not stop
it. `/` is the draft companion, `/cockpit` is the multi-league view. Logs to
`/tmp/ff-companion.log`.

Personal fantasy companion. Football for the 2026 season: six leagues, five
Yahoo and one Sleeper, all snake redraft. Basketball is arriving for 2026-27:
two Yahoo leagues, one points and one nine-category. So far that is the data
layer only — `npm run data:nba` joins Sleeper and FantasyPros projections,
three seasons of history, the schedule and Yahoo's ranks into `data/nba/`.
Football's code stays where it is through its season; the two sports are
sorted into their own folders once there is a second one to learn from.

Two apps, one process, one URL. `/` is the **draft companion** — the board, the
verdict and the pick clock, used beside a live draft room. `/cockpit` is the
**multi-league cockpit**, which answers the question that only exists when you
hold several leagues at once: which of these needs me now, and which can I leave
alone. No platform can answer it, because each one knows about exactly one of
your leagues.

The design constraint that drives everything: **the local app owns canonical
draft state, and every input source is a replaceable sensor.** Manual entry is
always live and is never a mode you have to enter. If every automated feed dies
mid-draft, the tool still works.

## Running it

```bash
npm install
npm run data:players      # canonical player map + bye weeks
npm run data:rankings     # BEER+ boards, one per league
npm run data:adjustments  # big-play rates and value calibration (optional)
npm run data:nba          # basketball: projections, history, schedule, teams
npm run values:nba        # basketball: points values (Harker), 9-cat builds (Hoops)
npm run draft:nba -- --league hoops --slot 9 --taken "…;…"   # basketball pick advice
npm start                 # http://localhost:4600
```

Node lives at `~/.local/node` on this machine; there is no Homebrew.

## Layout

```
src/
  kernel/        pure, offline, no network
    state.ts       pick log, applySnapshot, diffing
    snake.ts       closed-form snake position math
    value.ts       VOR, tiers, survival, VONA, run detection
    opponents.ts   opponent-aware survival (calibrated, see below)
    roster.ts      slots, needs, bye conflicts
    adjust.ts      scoring rules the ranking source cannot express
    preferences.ts likes/avoids and roster-construction rules
    explain.ts     the short case for or against one player
    match.ts       cross-platform name resolution
  adapters/      sensors — emit full snapshots, contain no logic
    sleeper.ts     public REST poll, no auth
    yahoo-ext.ts   receives snapshots pushed by the browser extension
  server/        HTTP + WebSocket, append-only pick log
  ui/            the draft companion and the cockpit (React)
  nba/           basketball, kept apart from football for now
    sources.ts     one parser per source, pure
    join.ts        name matching, consensus line, durability, team schedules
    value.ts       points value over replacement; 9-cat z-scores and punt builds
    draft.ts       pick advice: two-step lookahead on ADP survival; categories
                   scored as expected weekly wins, noise measured in-league
data/            league configs, player map, rankings, preferences
  nba/           basketball inputs (leagues, Yahoo ranks, team notes) and
                 the joined tables; raw/ is the download cache, not committed
fixtures/        recorded drafts for replay and calibration
scripts/         data pipeline and calibration harnesses
```

Adapters emit **full snapshots, not incremental events.** The kernel diffs, so
every source is idempotent and order-independent, and a sensor that drops
offline for thirty seconds recovers by itself.

## Platform notes

- **Sleeper** picks are public and unauthenticated. Poll every 2s.
- **Yahoo** `/f1/<id>/draftresults` is a plain server-rendered page carrying the
  full pick log. Polling it from any Yahoo tab is far more robust than reading
  React state in the draft room, needs no API approval, and works even when
  drafting from the phone. `?draft_results_period=previous` returns last
  season's draft, which is where the calibration fixtures come from.
- **Sleeper's `yahoo_id` is missing for roughly 45% of players**, including
  recent rookies. Cross-platform joins resolve by name, position and team.
- **Yahoo randomises draft order ~30 minutes before the draft**, so the draft
  slot cannot be set ahead of time.
- **TapThatDraft** config POSTs mint a permanent UUID URL. The board is a lazily
  hydrated Livewire component, so its `__lazyLoad` call has to be replayed.

Basketball:

- **Sleeper's NBA players carry no `yahoo_id` at all**, so every other source
  joins by name and team, with accents folded (Jokić, Şengün).
- **Yahoo's basketball game is 478.** The API gives ranks and ADP but no
  projections. Its token lives only on Railway, so `data/nba/yahoo-ranks.json`
  is a snapshot taken through the deployed server.
- **FantasyPros is the only free source that projects games played**, and it
  projects about seventy for nearly everyone. Durability from three seasons of
  Sleeper history is kept beside it rather than replaced by it.
- **ESPN is read for the schedule only.** Its rankings and projections are
  deliberately not used. The NBA's own stats and schedule endpoints refuse
  scripted requests.

## Opponent model

Survival to your next pick starts from ADP, then adjusts for the specific teams
picking in between — a team with two backs already is not taking a third.

Parameters were fitted on the real 2025 Fantasy Steward draft and validated on
the real 2025 Harker Green draft, which has different managers, a three-receiver
roster and fifteen rounds, and had no influence on the fit:

| | Steward (fitted) | Green (held out) | Green majority baseline |
|---|--:|--:|--:|
| top-1 accuracy | 50.0% | **51.7%** | 40.8% |
| logloss | 1.4503 | **1.1485** | 1.7918 (uniform) |

Three findings shaped the model:

1. **Opponents draft by ADP, not by value over replacement.** Scoring by BEER+
   value did worse than always guessing the most common position.
2. **The first guess at softmax temperature was four times too sharp**, which
   produced 0% and 100% survival claims the data does not support.
3. **Late rounds are a different game.** A model fitted across all rounds fails
   catastrophically out of sample, so the model stands aside after round 10 —
   where survival stops mattering anyway.

Per-position need weights were tried and **rejected**: they fit Steward well and
generalised worse than a single uniform weight.

The model is validated at the *position* level only. It has no demonstrated
skill at choosing between two players at the same position, so it informs the
survival estimate rather than driving it (`DEFAULT_ADP_WEIGHT = 0.72`).

Re-run the analysis with `npx tsx scripts/crossval.ts`.

## Testing it live

**Sleeper — works today.** Sleeper mock drafts create real draft ids, so the
adapter can be pointed at one without touching any config:

```bash
# start a mock at sleeper.com, then take the id out of the draft-room URL
SLEEPER_DRAFT_ID=1234567890123456789 npm run dev
```

Picks appear within two seconds of being made. The league's own draft id is the
default when the variable is unset.

**Yahoo — load the extension in `extension/`.** Chrome → `chrome://extensions`
→ Developer mode → Load unpacked. Then open any Yahoo fantasy page and leave it
open; the toolbar popup shows whether it can see the companion and how many
picks it has pushed.

The sensor polls Yahoo's own draft results page rather than reading the draft
room, which is why it needs no API approval, survives a redesign, and keeps
working while you draft from the phone. It matches the whole fantasysports
domain rather than a draft-room URL, because matching on URL shape is exactly
the failure this design exists to avoid.

Yahoo offline drafts populate that page only after the commissioner enters the
picks, so for those the sensor is a verification pass and manual entry is the
live path.

## Draft-night rules

- Never block the UI. Adapter failure shows a stale badge with seconds since
  last update. No spinners, no modal errors.
- Two-second answer. One screen, huge type, no scroll.
- Print the tiered cheat sheet. Paper is the last fallback and costs nothing.
- Set Yahoo pre-draft rankings in every league as the autopick fallback.
