#!/usr/bin/env python3
"""
Rebuilds a league's first-pick draft rank (data/nba/draft-rank/<league>.json) from fresh simulations.

Each of the top players by ADP (never-list excluded) is forced as my first pick, held back from the room until
then, in the same rooms at two slots; the rest of my draft is made once by the cards and once by a neutral
best-value drafter; the season is played out in box scores. scripts/nba-draft-rank.ts turns the per-draft lines
into the rank.

  python3 scripts/nba-rank-rebuild.py harker   # points: nba-points-sim.ts, slots 5 and 12, top 70
  python3 scripts/nba-rank-rebuild.py hoops    # categories: nba-strategy-sim.ts, slots 5 and 10, top 68

Runs eight simulations at a time (about 20 minutes for Harker, 40 for Hoops). The old rank is kept beside the new
one as <league>.prev.json so the two can be compared before shipping.
"""
import json, os, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEAGUES = {
    'harker': {'id': 'nba-harker', 'sim': 'scripts/nba-points-sim.ts', 'slots': (5, 12), 'top': 70, 'extra': []},
    'hoops': {'id': 'nba-hoops', 'sim': 'scripts/nba-strategy-sim.ts', 'slots': (5, 10), 'top': 68, 'extra': ['--room-spread', '2,0.12']},
}

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in LEAGUES:
        sys.exit(__doc__)
    cfg = LEAGUES[sys.argv[1]]
    work = os.path.join(ROOT, 'scratch', f"rank-{cfg['id']}")
    jobs_dir = os.path.join(work, 'jobs')
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(jobs_dir)
    players = json.load(open(os.path.join(ROOT, 'data/nba/players.json')))['players']
    never = set(json.load(open(os.path.join(ROOT, 'data/preferences/nba.json'))).get('never', []))
    top = [p['name'] for p in sorted(
        [p for p in players if p.get('yahoo') and p['yahoo'].get('adp') and p['name'] not in never and p.get('projection')],
        key=lambda p: p['yahoo']['adp'])[:cfg['top']]]
    jobs = []
    for name in [None] + top:
        for slot in cfg['slots']:
            for follow in ('cards', 'value'):
                tag = f"{follow}-{slot}-{(name or 'BASE').replace(' ', '_').replace(chr(39), '')}"
                args = ['--mode', 'pool', '--raw', '--slots', f'{slot}-{slot}', '--seeds', '200', '--dump', os.path.join(jobs_dir, f'{tag}.jsonl')] + cfg['extra']
                if name:
                    args += ['--first', name, '--reserve']
                if follow == 'value':
                    args += ['--follow', 'value']
                jobs.append(args)
    env = dict(os.environ, PATH=os.path.expanduser('~/.local/node/bin') + ':' + os.environ['PATH'])

    def run(args):
        out = args[args.index('--dump') + 1]
        for _ in range(2):  # one retry: a job now and then dies under load and runs fine alone
            if os.path.exists(out):
                os.remove(out)
            subprocess.run(['npx', 'tsx', cfg['sim']] + args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.exists(out) and sum(1 for _ in open(out)) >= 200:
                return True
        return False

    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(run, jobs))
    failed = [j[j.index('--dump') + 1] for j, k in zip(jobs, ok) if not k]
    if failed:
        sys.exit(f'{len(failed)} jobs failed: {failed[:5]}')
    for follow, name in (('cards', 'cards.jsonl'), ('value', 'neutral.jsonl')):
        with open(os.path.join(work, name), 'w') as w:
            for f in sorted(os.listdir(jobs_dir)):
                if f.startswith(follow + '-'):
                    w.write(open(os.path.join(jobs_dir, f)).read())
    rank = os.path.join(ROOT, 'data/nba/draft-rank', f"{cfg['id']}.json")
    if os.path.exists(rank):
        shutil.copy(rank, rank.replace('.json', '.prev.json'))
    subprocess.run(['npx', 'tsx', 'scripts/nba-draft-rank.ts', os.path.join(work, 'cards.jsonl'), os.path.join(work, 'neutral.jsonl'), cfg['id']], cwd=ROOT, env=env, check=True)
    print(f'rebuilt {rank} from {len(jobs)} jobs')

main()
