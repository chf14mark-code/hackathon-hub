// engine.js - the whole simulation. Pure JavaScript: no React, no randomness,
// no storage. Every number the UI shows is produced by this file.
//
// MODEL (keep this in sync with the "Simplifications" note in the UI):
//  * 6 instructions: MOV, LOAD, STORE, ADD, SUB, JNZ.  4 registers R0-R3 (16-bit).
//  * Instructions are read from a separate program list. Reading them is free.
//  * Data memory ("Warehouse") has 64 cells, addresses 0-63. Cells are grouped
//    into boxes ("cache lines") of 4 cells: cells 0-3 = box 0, 4-7 = box 1, ...
//  * One cache ("Desk") with 4 slots, each holding one whole box. Fully
//    associative, least-recently-used (LRU) replacement.
//  * LOAD/STORE cost 3 ticks if the box is on the Desk (hit), 100 ticks if not
//    (miss: the whole box is brought to the Desk). STORE is write-allocate and
//    write-through (RAM is always up to date, so the cache stores only tags).
//  * Every other instruction costs 1 tick. The 5 phases of an instruction
//    (fetch, PC+1, decode, execute, write-back) are display sub-steps: they do
//    not add ticks of their own.

export const CONFIG = Object.freeze({
  memSize: 64,
  lineSize: 4,
  cacheLines: 4,
  hitLatency: 3,
  missLatency: 100,
  maxTicks: 100000,
  maxInstructions: 5000,
  maxProgramLines: 16,
});

const MASK = 0xffff; // registers and memory cells are 16-bit
const clone = (x) => JSON.parse(JSON.stringify(x));
export const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

export const PRESETS = [
  {
    id: 'add',
    title: 'Add two numbers from memory',
    code: [
      'LOAD R1, [4]   ; read cell 4 into R1',
      'LOAD R2, [5]   ; read cell 5 (its neighbour) into R2',
      'ADD R1, R2     ; R1 = R1 + R2',
      'STORE R1, [8]  ; save the answer in cell 8',
    ].join('\n'),
  },
  {
    id: 'count',
    title: 'Count down loop',
    code: [
      'MOV R0, 3      ; how many times to repeat',
      'MOV R1, 0      ; running total',
      'ADD R1, 2      ; add 2',
      'SUB R0, 1      ; one fewer round to go',
      'JNZ R0, 2      ; not zero yet? jump back to line 2',
    ].join('\n'),
  },
];

export const defaultMemory = () => Array.from({ length: CONFIG.memSize }, (_, i) => i + 1);

// ---------------------------------------------------------------- parsing --

const SHAPES = {
  MOV: { args: ['reg', 'regimm'], example: 'MOV R0, 5' },
  LOAD: { args: ['reg', 'mem'], example: 'LOAD R1, [4]' },
  STORE: { args: ['reg', 'mem'], example: 'STORE R1, [8]' },
  ADD: { args: ['reg', 'regimm'], example: 'ADD R0, R1' },
  SUB: { args: ['reg', 'regimm'], example: 'SUB R0, 1' },
  JNZ: { args: ['reg', 'imm'], example: 'JNZ R0, 2' },
};

function parseOperand(raw) {
  const s = raw.trim();
  let m = s.match(/^R([0-3])$/i);
  if (m) return { t: 'reg', n: Number(m[1]) };
  m = s.match(/^(0x[0-9a-f]+|\d+)$/i);
  if (m) return { t: 'imm', v: Number(m[1]) };
  m = s.match(/^\[(.+)\]$/);
  if (m) {
    const inner = parseOperand(m[1]);
    if (inner && inner.t !== 'mem') return { t: 'mem', base: inner };
  }
  return null;
}

export function fmtOperand(o) {
  if (o.t === 'reg') return `R${o.n}`;
  if (o.t === 'imm') return String(o.v);
  return `[${fmtOperand(o.base)}]`;
}

const fits = (kind, o) =>
  (kind === 'reg' && o.t === 'reg') ||
  (kind === 'imm' && o.t === 'imm') ||
  (kind === 'regimm' && (o.t === 'reg' || o.t === 'imm')) ||
  (kind === 'mem' && o.t === 'mem');

function parseLine(code) {
  const m = code.match(/^([A-Za-z]+)\s*(.*)$/);
  if (!m) return { error: `"${code}" is not an instruction. Try: MOV R0, 5` };
  const op = m[1].toUpperCase();
  const shape = SHAPES[op];
  if (!shape) {
    return { error: `Unknown instruction "${m[1]}". Use MOV, LOAD, STORE, ADD, SUB or JNZ.` };
  }
  const rawArgs = m[2] ? m[2].split(',') : [];
  if (rawArgs.length !== shape.args.length) {
    return { error: `${op} needs ${shape.args.length} operands, like "${shape.example}".` };
  }
  const args = rawArgs.map(parseOperand);
  for (let i = 0; i < args.length; i++) {
    if (!args[i] || !fits(shape.args[i], args[i])) {
      return { error: `Operand ${i + 1} of ${op} is not valid. Example: "${shape.example}".` };
    }
  }
  for (const a of args) {
    if (a.t === 'imm' && a.v > MASK) return { error: `The number ${a.v} is too big (max ${MASK}).` };
    if (a.t === 'mem' && a.base.t === 'imm' && a.base.v >= CONFIG.memSize) {
      return { error: `Address ${a.base.v} is outside memory (0 to ${CONFIG.memSize - 1}).` };
    }
  }
  const text = `${op} ${args.map(fmtOperand).join(', ')}`;
  return { instr: { op, args, text } };
}

export function parseProgram(text) {
  const instrs = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const code = raw.split(';')[0].trim();
    if (!code) return;
    const r = parseLine(code);
    if (r.error) errors.push({ line: i + 1, message: r.error });
    else instrs.push({ ...r.instr, srcLine: i + 1 });
  });
  if (instrs.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'The program is empty. Add at least one instruction.' });
  }
  if (instrs.length > CONFIG.maxProgramLines) {
    errors.push({ line: 0, message: `Too many instructions (max ${CONFIG.maxProgramLines}).` });
  }
  instrs.forEach((ins) => {
    if (ins.op === 'JNZ' && ins.args[1].v >= instrs.length) {
      errors.push({
        line: ins.srcLine,
        message: `JNZ jumps to line ${ins.args[1].v}, but the program only has lines 0 to ${instrs.length - 1}.`,
      });
    }
  });
  return { instrs, errors, ok: errors.length === 0 };
}

// ------------------------------------------------------------ explanations --

const UNIT_OF = { MOV: 'CU', JNZ: 'CU', ADD: 'ALU', SUB: 'ALU', LOAD: 'LSU', STORE: 'LSU' };

const OP_MEANING = {
  MOV: 'MOV = put a value into a register',
  LOAD: 'LOAD = read a memory cell into a register',
  STORE: 'STORE = write a register into a memory cell',
  ADD: 'ADD = add two numbers',
  SUB: 'SUB = subtract a number',
  JNZ: 'JNZ = jump if not zero',
};

const ROUTE = {
  ALU: 'This is a maths job, so the Control Unit sends it to the ALU.',
  LSU: 'This is a memory job, so the Control Unit sends it to the memory helper (LSU).',
  CU: 'This job is simple, so the Control Unit does it by itself.',
};

function operandMeaning(o, role) {
  if (o.t === 'reg') {
    if (role === 'dest') return `${fmtOperand(o)} = the register that receives the answer`;
    if (role === 'check') return `${fmtOperand(o)} = the register to check`;
    return `${fmtOperand(o)} = a register to read`;
  }
  if (o.t === 'imm') {
    if (role === 'target') return `${o.v} = the program line to jump to`;
    return `${o.v} = a plain number`;
  }
  return o.base.t === 'reg'
    ? `${fmtOperand(o)} = the memory address stored in ${fmtOperand(o.base)}`
    : `${fmtOperand(o)} = memory cell ${o.base.v}`;
}

function decodeInfo(ins) {
  const [a, b] = ins.args;
  const parts = [{ text: ins.op, role: 'opcode', meaning: OP_MEANING[ins.op] }];
  if (ins.op === 'STORE') {
    parts.push({ text: fmtOperand(a), role: 'src', meaning: `${fmtOperand(a)} = the register to save` });
    parts.push({ text: fmtOperand(b), role: 'addr', meaning: operandMeaning(b, 'addr') });
  } else if (ins.op === 'JNZ') {
    parts.push({ text: fmtOperand(a), role: 'check', meaning: operandMeaning(a, 'check') });
    parts.push({ text: fmtOperand(b), role: 'target', meaning: operandMeaning(b, 'target') });
  } else {
    parts.push({ text: fmtOperand(a), role: 'dest', meaning: operandMeaning(a, 'dest') });
    parts.push({ text: fmtOperand(b), role: b.t === 'mem' ? 'addr' : 'src', meaning: operandMeaning(b, 'src') });
  }
  const unit = UNIT_OF[ins.op];
  return { unit, op: ins.op, parts, route: ROUTE[unit] };
}

export function glossLine(ins) {
  const [a, b] = ins.args;
  const f = fmtOperand;
  switch (ins.op) {
    case 'MOV':
      return b.t === 'reg' ? `Copy ${f(b)} into ${f(a)}` : `Put the number ${b.v} into ${f(a)}`;
    case 'LOAD':
      return b.base.t === 'reg'
        ? `Read the cell whose address is in ${f(b.base)} into ${f(a)}`
        : `Read memory cell ${b.base.v} into ${f(a)}`;
    case 'STORE':
      return b.base.t === 'reg'
        ? `Write ${f(a)} into the cell whose address is in ${f(b.base)}`
        : `Write ${f(a)} into memory cell ${b.base.v}`;
    case 'ADD':
      return `${f(a)} = ${f(a)} + ${f(b)}`;
    case 'SUB':
      return `${f(a)} = ${f(a)} - ${f(b)}`;
    default:
      return `If ${f(a)} is not zero, jump to line ${b.v}`;
  }
}

// ----------------------------------------------------------------- machine --

export function createMachine({ memory = defaultMemory(), cacheEnabled = true } = {}) {
  return {
    pc: 0,
    ir: '',
    regs: [0, 0, 0, 0],
    mem: memory.slice(0, CONFIG.memSize),
    cache: {
      enabled: cacheEnabled,
      clock: 0,
      lines: Array.from({ length: CONFIG.cacheLines }, () => ({ valid: false, tag: -1, lastUsed: 0 })),
    },
    cycles: 0,
    memWait: 0,
    aluBusy: 0,
    hits: 0,
    misses: 0,
    uncached: 0,
    instrCount: 0,
    halted: false,
    error: null,
  };
}

export const isFinished = (s, instrs) => s.halted || s.pc >= instrs.length;

export function flushCache(state) {
  const s = clone(state);
  s.cache.lines = s.cache.lines.map(() => ({ valid: false, tag: -1, lastUsed: 0 }));
  return s;
}

// Starts the program again from line 0 but keeps memory and the Desk as they
// are ("warm" cache). Registers, PC and the tick counters start from zero.
export function rerunWarm(state) {
  const fresh = createMachine({ memory: state.mem, cacheEnabled: state.cache.enabled });
  fresh.cache = clone(state.cache);
  return fresh;
}

// Looks the address up in the cache and updates it. Returns what happened.
function accessMemory(s, addr) {
  const line = Math.floor(addr / CONFIG.lineSize);
  const start = line * CONFIG.lineSize;
  const base = { line, start, end: start + CONFIG.lineSize - 1, evictedTag: null, slot: -1 };

  if (!s.cache.enabled) {
    s.uncached += 1;
    return { ...base, result: 'uncached', latency: CONFIG.missLatency };
  }
  const c = s.cache;
  c.clock += 1;
  const hitSlot = c.lines.findIndex((l) => l.valid && l.tag === line);
  if (hitSlot >= 0) {
    c.lines[hitSlot].lastUsed = c.clock;
    s.hits += 1;
    return { ...base, result: 'hit', latency: CONFIG.hitLatency, slot: hitSlot };
  }
  let victim = c.lines.findIndex((l) => !l.valid);
  let evictedTag = null;
  if (victim < 0) {
    victim = 0;
    c.lines.forEach((l, i) => {
      if (l.lastUsed < c.lines[victim].lastUsed) victim = i;
    });
    evictedTag = c.lines[victim].tag;
  }
  c.lines[victim] = { valid: true, tag: line, lastUsed: c.clock };
  s.misses += 1;
  return { ...base, result: 'miss', latency: CONFIG.missLatency, slot: victim, evictedTag };
}

// Runs ONE instruction and returns its phases. Each phase carries a full
// snapshot ("snap") of the machine after that phase, so the UI is simply a
// function of (phase, snap).
// Phase order: fetch, pc-update, decode, execute, [pc-update for JNZ], writeback.
export function stepInstruction(prev, instrs) {
  const s = clone(prev);
  const phases = [];
  const push = (kind, data = {}) => phases.push({ kind, ...data, snap: clone(s) });
  const fail = (message) => {
    s.halted = true;
    s.error = message;
    push('error', { message });
    return { phases, state: s };
  };

  if (s.halted || s.pc >= instrs.length) {
    s.halted = true;
    return { phases: [], state: s };
  }
  if (s.cycles >= CONFIG.maxTicks || s.instrCount >= CONFIG.maxInstructions) {
    return fail('Stopped: the program ran for too long. Is there a loop that never ends?');
  }

  const line = s.pc;
  const ins = instrs[line];
  const [a, b] = ins.args;
  const value = (o) => (o.t === 'reg' ? s.regs[o.n] : o.v);
  s.instrCount += 1;

  // 1. FETCH: the instruction at line PC is copied into the IR.
  s.ir = ins.text;
  push('fetch', { pc: line, text: ins.text });

  // 2. PC + 1: the PC moves on to the next line.
  s.pc = line + 1;
  push('pc-update', { from: line, to: s.pc, reason: 'sequential' });

  // 3. DECODE: the Control Unit works out what the instruction means.
  push('decode', { line, text: ins.text, ...decodeInfo(ins) });

  // 4. EXECUTE and 5. WRITE-BACK
  switch (ins.op) {
    case 'ADD':
    case 'SUB': {
      const x = s.regs[a.n];
      const y = value(b);
      const result = ins.op === 'ADD' ? (x + y) & MASK : (x - y + 0x10000) & MASK;
      s.cycles += 1;
      s.aluBusy += 1;
      push('execute', {
        unit: 'ALU', op: ins.op, symbol: ins.op === 'ADD' ? '+' : '-',
        aReg: a.n, aLabel: fmtOperand(a), a: x,
        bReg: b.t === 'reg' ? b.n : null, bLabel: fmtOperand(b), b: y,
        result, cyclesBefore: s.cycles - 1, cyclesAfter: s.cycles,
      });
      const old = s.regs[a.n];
      s.regs[a.n] = result;
      push('writeback', {
        unit: 'ALU', target: 'register', name: `R${a.n}`, regIndex: a.n, oldValue: old, newValue: result,
      });
      break;
    }
    case 'MOV': {
      const v = value(b);
      s.cycles += 1;
      push('execute', {
        unit: 'CU', op: 'MOV', value: v, srcLabel: fmtOperand(b), dest: `R${a.n}`,
        cyclesBefore: s.cycles - 1, cyclesAfter: s.cycles,
      });
      const old = s.regs[a.n];
      s.regs[a.n] = v;
      push('writeback', {
        unit: 'CU', target: 'register', name: `R${a.n}`, regIndex: a.n, oldValue: old, newValue: v,
      });
      break;
    }
    case 'JNZ': {
      const v = s.regs[a.n];
      const taken = v !== 0;
      s.cycles += 1;
      push('execute', {
        unit: 'CU', op: 'JNZ', regName: `R${a.n}`, regValue: v, taken, target: b.v,
        cyclesBefore: s.cycles - 1, cyclesAfter: s.cycles,
      });
      const from = s.pc;
      if (taken) s.pc = b.v;
      push('pc-update', { from, to: s.pc, reason: taken ? 'jump-taken' : 'jump-not-taken' });
      push('writeback', { unit: 'CU', target: 'none' });
      break;
    }
    case 'LOAD':
    case 'STORE': {
      const base = b.base;
      const addr = value(base);
      if (addr < 0 || addr >= CONFIG.memSize) {
        return fail(
          `Line ${line}: ${ins.text} uses address ${addr}, which is outside memory (0 to ${CONFIG.memSize - 1}).`,
        );
      }
      const addrLabel = base.t === 'reg' ? `${fmtOperand(base)} = ${addr}` : `${addr}`;
      const storing = ins.op === 'STORE';
      const v = storing ? s.regs[a.n] : s.mem[addr];
      const snapPre = clone(s);
      const before = s.cycles;
      const acc = accessMemory(s, addr);
      s.cycles += acc.latency;
      s.memWait += acc.latency;
      push('execute', {
        unit: 'LSU', op: ins.op, address: addr, addrLabel, access: acc.result, latency: acc.latency,
        line: acc.line, start: acc.start, end: acc.end, slot: acc.slot, evictedTag: acc.evictedTag,
        value: v, srcReg: storing ? a.n : null, cyclesBefore: before, cyclesAfter: s.cycles, snapPre,
      });
      if (storing) {
        const old = s.mem[addr];
        s.mem[addr] = v;
        push('writeback', { unit: 'LSU', target: 'memory', address: addr, oldValue: old, newValue: v });
      } else {
        const old = s.regs[a.n];
        s.regs[a.n] = v;
        push('writeback', {
          unit: 'LSU', target: 'register', name: `R${a.n}`, regIndex: a.n, oldValue: old, newValue: v,
        });
      }
      break;
    }
    default:
      return fail(`Unknown instruction ${ins.op}.`);
  }
  return { phases, state: s };
}

export function runToEnd(state, instrs) {
  let s = state;
  while (!isFinished(s, instrs)) s = stepInstruction(s, instrs).state;
  return s;
}

export function summarize(s) {
  return {
    ticks: s.cycles,
    memWait: s.memWait,
    waitPct: s.cycles ? Math.round((100 * s.memWait) / s.cycles) : 0,
    aluBusy: s.aluBusy,
    hits: s.hits,
    misses: s.misses,
    uncached: s.uncached,
  };
}
