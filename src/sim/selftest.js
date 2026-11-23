// selftest.js - checks the engine against numbers worked out by hand.
// Runs in Node (`node src/selftest.js`) and inside the app (footer panel).
import {
  PRESETS, createMachine, defaultMemory, flushCache, isFinished,
  parseProgram, rerunWarm, runToEnd, stepInstruction, summarize,
} from './engine.js';

const preset = (id) => parseProgram(PRESETS.find((p) => p.id === id).code).instrs;
const run = (instrs, opts) => runToEnd(createMachine(opts), instrs);
const phasesOf = (s, instrs) => stepInstruction(s, instrs).phases;
const kinds = (phases) => phases.map((p) => p.kind).join(' > ');

export function runSelfTests() {
  const out = [];
  const check = (name, expected, actual, why) =>
    out.push({ name, expected: String(expected), actual: String(actual), pass: String(expected) === String(actual), why });

  // 1. Add two numbers (cache on). Hand count:
  //    LOAD [4] miss 100 + LOAD [5] hit 3 + ADD 1 + STORE [8] miss 100 = 204
  const add = preset('add');
  const a = run(add);
  check('Add program: total ticks', 204, a.cycles, '100 (miss) + 3 (hit, same box) + 1 (ADD) + 100 (miss on a new box)');
  check('Add program: hits / misses', '1 / 2', `${a.hits} / ${a.misses}`, 'cell 5 shares a box with cell 4');
  check('Add program: R1 = cell4 + cell5', 11, a.regs[1], 'cells start as address + 1, so 5 + 6');
  check('Add program: cell 8 holds the answer', 11, a.mem[8], 'STORE wrote R1 into cell 8');

  // 1b. Run again with the Desk still warm: 3 + 3 + 1 + 3 = 10 ticks
  const warm = runToEnd(rerunWarm(a), add);
  check('Warm re-run: total ticks', 10, warm.cycles, 'boxes 1 and 2 are already on the Desk, so every access is a 3-tick hit');
  check('Warm re-run: misses', 0, warm.misses, 'nothing had to be fetched again');

  // 2. Same program with the cache switched off: 100 + 100 + 1 + 100 = 301
  const off = run(add, { cacheEnabled: false });
  check('Cache off: total ticks', 301, off.cycles, 'every memory access goes to RAM');
  check('Cache off: hits', 0, off.hits, 'there is no cache to hit');

  // 3. Count down loop: 2 MOV + 3 rounds x (ADD + SUB + JNZ) = 11 ticks
  const cnt = run(preset('count'));
  check('Loop program: total ticks', 11, cnt.cycles, '2 + 3 x 3');
  check('Loop program: R1 / R0', '6 / 0', `${cnt.regs[1]} / ${cnt.regs[0]}`, 'added 2 three times; counter reached 0');

  // 4. Phase order of one ALU instruction
  const addPhases = phasesOf({ ...createMachine(), pc: 2, regs: [0, 5, 6, 0] }, add);
  check('ADD phase order', 'fetch > pc-update > decode > execute > writeback', kinds(addPhases), 'always the same order');
  const ex = addPhases.find((p) => p.kind === 'execute');
  const wb = addPhases.find((p) => p.kind === 'writeback');
  check('ADD execute shows the real sum', '5 + 6 = 11', `${ex.a} + ${ex.b} = ${ex.result}`, 'ALU worked on the register values');
  check('ADD write-back old -> new', '5 -> 11', `${wb.oldValue} -> ${wb.newValue}`, 'R1 changes');

  // 5. JNZ taken / not taken
  const loop = preset('count');
  const taken = phasesOf({ ...createMachine(), pc: 4, regs: [2, 0, 0, 0] }, loop);
  check('JNZ taken: PC updates', 'sequential 4->5, jump-taken 5->2',
    taken.filter((p) => p.kind === 'pc-update').map((p) => `${p.reason} ${p.from}->${p.to}`).join(', '),
    'R0 = 2 is not zero, so jump back to line 2');
  const notTaken = phasesOf({ ...createMachine(), pc: 4, regs: [0, 0, 0, 0] }, loop);
  check('JNZ not taken: PC stays', 'jump-not-taken 5->5',
    notTaken.filter((p) => p.kind === 'pc-update' && p.reason !== 'sequential').map((p) => `${p.reason} ${p.from}->${p.to}`).join(', '),
    'R0 = 0, so carry on');

  // 6. LOAD latency by hit / miss
  const l1 = stepInstruction(createMachine(), add);
  const e1 = l1.phases.find((p) => p.kind === 'execute');
  const l2 = stepInstruction(l1.state, add);
  const e2 = l2.phases.find((p) => p.kind === 'execute');
  check('First LOAD', 'miss, 100 ticks, box cells 4-7', `${e1.access}, ${e1.latency} ticks, box cells ${e1.start}-${e1.end}`, 'cold cache');
  check('Neighbour LOAD', 'hit, 3 ticks', `${e2.access}, ${e2.latency} ticks`, 'the whole box came along');

  // 7. LRU eviction: 5 different boxes through a 4-slot cache, then box 0 again
  const lru = parseProgram(['LOAD R0, [0]', 'LOAD R0, [4]', 'LOAD R0, [8]', 'LOAD R0, [12]', 'LOAD R0, [16]', 'LOAD R0, [0]'].join('\n')).instrs;
  const l = run(lru);
  check('LRU: box 0 was evicted', '6 misses, 0 hits', `${l.misses} misses, ${l.hits} hits`, 'box 4 pushed out the least recently used box (0)');

  // 8. Flush cache
  const fl = flushCache(a);
  check('Flush cache empties every slot', 0, fl.cache.lines.filter((x) => x.valid).length, 'cold start');

  // 9. Parser and error handling
  const bad = parseProgram('MOV R0, 5\nFOO R2, 3');
  check('Parser reports the bad line', 'line 2, unknown instruction', `line ${bad.errors[0]?.line}, ${/Unknown instruction/.test(bad.errors[0]?.message || '') ? 'unknown instruction' : 'other'}`, 'helpful error');
  const oob = run(parseProgram('MOV R2, 200\nLOAD R1, [R2]').instrs);
  check('Out-of-range address stops the machine', 'halted with an error', oob.halted && oob.error ? 'halted with an error' : 'no error', 'address 200 > 63');
  check('Finished flag', true, isFinished(a, add), 'program ran to its end');

  // 10. Summary numbers
  const sum = summarize(a);
  check('Waiting for memory (add program)', '203 ticks (100%)', `${sum.memWait} ticks (${sum.waitPct}%)`, '100 + 3 + 100 ticks were spent on memory');

  void defaultMemory;
  return out;
}
