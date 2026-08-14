/* COMPARE MEASUREMENT RUNS, AND SAY WHETHER THEY PASS.
 *
 *   node scripts/tv-perf-report.mjs before.json after.json
 *   node scripts/tv-perf-report.mjs one.json                 (single run, no delta)
 *   node scripts/tv-perf-report.mjs a.json b.json --runs     (per-round values, not just the mean)
 *
 * WHY IT NO LONGER REPORTS A MEAN AND STOPS. An average frame time cannot express smoothness: a run
 * can sit at a perfect 16.7ms median and still lurch eight times, and an earlier version of this
 * report called 76% "on time" while the same data contained 142ms frames — eight skipped display
 * frames each. Smoothness is the absence of a tail, so the tail is what gets printed: p95, p99, the
 * worst frame, how many frames exceeded 67ms, and the longest unbroken run over 50ms.
 *
 * RULES IT ENFORCES, because a comparison that quietly includes junk is worse than no comparison:
 *   · BLOCKS THAT WERE NOT A MEASUREMENT ARE DROPPED (`live: false` — a press that changed nothing).
 *   · ROUNDS ARE AVERAGED, NOT CONCATENATED, so a run with more rounds cannot outvote one with fewer.
 *   · THE IDLE CONTROL IS REPORTED SEPARATELY and never mixed into a per-press figure.
 *   · THE BUILD STAMP OF EACH FILE IS PRINTED, because two runs of different bundles are not a
 *     comparison and the stamp is the only thing that can tell.
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SHOW_RUNS = process.argv.includes('--runs');
if (!files.length) {
  console.error('usage: node scripts/tv-perf-report.mjs <a.json> [b.json] [--runs]');
  process.exit(1);
}
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));

/* ---- THE ACCEPTANCE CRITERIA, as given. Kept here so the report can be checked against them
 * mechanically rather than by reading a table and forming an impression. */
const CRITERIA = {
  onTimeDeliberate: 95,
  onTimeHeld: 90,
  p95: 33.33,
  p99: 50,
  worst: 67,
  maxRunOver50: 1,
  latency: 33,
};

const KEYS = ['onTimePct', 'p50', 'p95', 'p99', 'worstFrame', 'latencyMedian', 'latencyP95', 'droppedFrames', 'maxRunOverBudget', 'maxRunOver50', 'framesOver67'];

function fold(run) {
  const acc = new Map();
  const perRound = new Map();
  let idle = null, idleN = 0;
  for (const round of run.rounds) {
    for (const b of round.blocks) {
      if (b.axis === 'idle') {
        if (!idle) idle = { onTimePct: 0, p95: 0, p99: 0, worstFrame: 0, framesOver67: 0 };
        for (const k of Object.keys(idle)) idle[k] += b[k] ?? 0;
        idleN++;
        continue;
      }
      if (b.live === false) continue;
      const key = `${b.surface}/${b.axis}/${b.cadence}`;
      const cur = acc.get(key) || { n: 0, within: [0, 0, 0, 0, 0] };
      for (const k of KEYS) cur[k] = (cur[k] ?? 0) + (b[k] ?? 0);
      if (Array.isArray(b.within)) b.within.forEach((v, i) => { cur.within[i] += v; });
      cur.n++;
      acc.set(key, cur);
      if (!perRound.has(key)) perRound.set(key, []);
      perRound.get(key).push(b);
    }
  }
  const out = new Map();
  for (const [k, v] of acc) {
    const o = { rounds: v.n, within: v.within.map((x) => x / v.n) };
    for (const key of KEYS) o[key] = v[key] / v.n;
    out.set(k, o);
  }
  if (idle) for (const k of Object.keys(idle)) idle[k] /= idleN;
  return { blocks: out, idle, perRound };
}

const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const banner = (r, file) => {
  const b = r.build;
  console.log(`  ${file}`);
  if (b) {
    console.log(`      build ${b.commit}${b.dirty ? '+dirty' : '  *** CLEAN — is this the tree you changed? ***'}  ${b.mode}  ${b.builtAt}`);
    console.log(`      previews=${b.previews}  scroll=${b.scroll}  rows=${b.rows}  @ ${b.url}`);
  } else console.log('      (no build stamp — measured before the stamp existed)');
  if (r.settled) {
    const s = r.settled;
    console.log(`      at rest: rows ${s.rows} cards ${s.cards} img ${s.imagesDecoded}/${s.images} bitmap ~${s.bitmapMb}MB heap ${s.heapUsedMb}MB`);
  }
};

/* TWO RUNS OF DIFFERENT PAGES ARE NOT A COMPARISON, and the settled sample is the only place that
 * shows it. A row-window A/B once ran 15 rows against 9 and the smaller page won for reasons that
 * had nothing to do with the change. Loud, and before the table, so it cannot be read past. */
function assertComparable(x, y) {
  if (!x?.settled || !y?.settled) return;
  const a = x.settled, b = y.settled;
  if (a.rows !== b.rows || Math.abs(a.cards - b.cards) > 4) {
    console.log('\n  *** THESE RUNS ARE NOT COMPARABLE ***');
    console.log(`      before: ${a.rows} rows / ${a.cards} cards      after: ${b.rows} rows / ${b.cards} cards`);
    console.log('      A page with fewer rows does less work. Re-run both arms; the table below is not a result.\n');
  }
}

const A = load(files[0]);
const B = files[1] ? load(files[1]) : null;
const a = fold(A);
const b = B ? fold(B) : null;

console.log('');
banner(A, files[0]);
if (B) { console.log(''); banner(B, files[1]); assertComparable(A, B); }

if (a.idle) {
  const i = a.idle;
  const j = b?.idle;
  console.log(`\n  IDLE CONTROL   on-time ${f1(i.onTimePct)}%  p95 ${f1(i.p95)}  p99 ${f1(i.p99)}  worst ${f1(i.worstFrame)}  >67ms ${f1(i.framesOver67)}`
    + (j ? `\n            ->   on-time ${f1(j.onTimePct)}%  p95 ${f1(j.p95)}  p99 ${f1(j.p99)}  worst ${f1(j.worstFrame)}  >67ms ${f1(j.framesOver67)}` : ''));
}

const row = (label, v) => `  ${label.padEnd(30)} ${f1(v.onTimePct).padStart(6)}% ${f1(v.p50).padStart(7)} ${f1(v.p95).padStart(7)} ${f1(v.p99).padStart(7)} ${f1(v.worstFrame).padStart(8)} ${f1(v.framesOver67).padStart(5)} ${f1(v.maxRunOver50).padStart(6)} ${f1(v.latencyMedian).padStart(7)}`;

console.log(`\n  ${'block'.padEnd(30)} on-time     p50     p95     p99    worst  >67  run50  press`);
console.log(`  ${'-'.repeat(96)}`);
const keys = Array.from(a.blocks.keys()).sort();
for (const k of keys) {
  console.log(row(k, a.blocks.get(k)));
  if (b?.blocks.has(k)) console.log(row('  -> after', b.blocks.get(k)));
  if (SHOW_RUNS) {
    const rounds = (b ?? a).perRound.get(k) || [];
    console.log(`      per-run on-time: ${rounds.map((r) => f1(r.onTimePct)).join('  ')}`);
    console.log(`      per-run worst  : ${rounds.map((r) => f1(r.worstFrame)).join('  ')}`);
  }
}

/* ---- WITHIN-BUCKET DISTRIBUTION, which is the shape of the tail rather than a single number. */
const target = b ?? a;
console.log(`\n  ${'block'.padEnd(30)}  <=16.67  <=33.33    <=50    <=67   <=100`);
console.log(`  ${'-'.repeat(72)}`);
for (const k of Array.from(target.blocks.keys()).sort()) {
  const w = target.blocks.get(k).within;
  console.log(`  ${k.padEnd(30)} ${w.map((x) => `${f1(x)}%`.padStart(8)).join('')}`);
}

/* ---- PASS / FAIL, stated mechanically ------------------------------------------------------- */
console.log('\n  ACCEPTANCE (of the run being reported)');
let allPass = true;
for (const k of Array.from(target.blocks.keys()).sort()) {
  const v = target.blocks.get(k);
  const held = /held/.test(k);
  const wantOnTime = held ? CRITERIA.onTimeHeld : CRITERIA.onTimeDeliberate;
  const checks = [
    [`on-time >= ${wantOnTime}%`, v.onTimePct >= wantOnTime, `${f1(v.onTimePct)}%`],
    [`p95 <= ${CRITERIA.p95}`, v.p95 <= CRITERIA.p95, f1(v.p95)],
    [`p99 <= ${CRITERIA.p99}`, v.p99 <= CRITERIA.p99, f1(v.p99)],
    [`worst <= ${CRITERIA.worst}`, v.worstFrame <= CRITERIA.worst, f1(v.worstFrame)],
    [`no consecutive >50ms`, v.maxRunOver50 <= CRITERIA.maxRunOver50, f1(v.maxRunOver50)],
    [`press latency <= ${CRITERIA.latency}ms`, v.latencyMedian <= CRITERIA.latency, f1(v.latencyMedian)],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) allPass = false;
  console.log(`    ${failed.length ? 'FAIL' : 'PASS'}  ${k.padEnd(28)}${failed.map(([n, , got]) => `${n} (got ${got})`).join('; ')}`);
}
console.log(`\n  ${allPass ? 'ALL BLOCKS MEET THE CRITERIA.' : 'NOT YET MEETING THE CRITERIA — see the FAIL lines above.'}\n`);
