/* src/App.jsx */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Clock, Pause, Pencil, Play, RotateCcw, SkipForward, StepForward, Trash2 } from 'lucide-react';
import {
  CONFIG, PRESETS, createMachine, defaultMemory, flushCache, glossLine, hex, isFinished,
  parseProgram, rerunWarm, runToEnd, stepInstruction, summarize,
} from './engine.js';
import { runSelfTests } from './selftest.js';

/* ------------------------------------------------------------------ look -- */
// One colour per part, always paired with a text label (never colour alone).
const TONES = {
  pc: { hex: '#b45309', edge: 'border-amber-600', ink: 'text-amber-900', ring: 'ring-amber-500' },
  ir: { hex: '#0f766e', edge: 'border-teal-600', ink: 'text-teal-900', ring: 'ring-teal-500' },
  cu: { hex: '#6d28d9', edge: 'border-violet-600', ink: 'text-violet-900', ring: 'ring-violet-500' },
  alu: { hex: '#c2410c', edge: 'border-orange-600', ink: 'text-orange-900', ring: 'ring-orange-500' },
  lsu: { hex: '#1d4ed8', edge: 'border-blue-600', ink: 'text-blue-900', ring: 'ring-blue-500' },
  reg: { hex: '#475569', edge: 'border-slate-500', ink: 'text-slate-900', ring: 'ring-slate-500' },
  desk: { hex: '#047857', edge: 'border-emerald-600', ink: 'text-emerald-900', ring: 'ring-emerald-500' },
  ram: { hex: '#57534e', edge: 'border-stone-500', ink: 'text-stone-900', ring: 'ring-stone-500' },
};

const btn =
  'inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-40';
const btnPrimary = `${btn} border-slate-900 bg-slate-900 text-white hover:bg-slate-700`;
const btnPlain = `${btn} border-slate-400 bg-white text-slate-900 hover:bg-slate-100`;

const STRIP = [
  { id: 'fetch', label: 'Fetch' },
  { id: 'pc-update', label: 'PC + 1' },
  { id: 'decode', label: 'Decode' },
  { id: 'execute', label: 'Execute' },
  { id: 'writeback', label: 'Write-back' },
];

const stripId = (v) => {
  if (!v || v.kind === 'error') return null;
  if (v.kind === 'pc-update') return v.reason === 'sequential' ? 'pc-update' : 'execute';
  return v.kind;
};

// How long each phase lasts at 1x speed (milliseconds). The tick counter still
// counts every real tick; only the animation is compressed.
function phaseDuration(v) {
  if (!v) return 400;
  switch (v.kind) {
    case 'fetch': return 1200;
    case 'pc-update': return 900;
    case 'decode': return 1900;
    case 'execute':
      if (v.unit === 'LSU') return v.access === 'hit' ? 1500 : 3200;
      return 1500;
    case 'writeback': return 1300;
    default: return 1200;
  }
}

/* --------------------------------------------------------------- wiring --- */
const WIRES = [
  { id: 'pc-prog', from: 'pc', to: 'program', label: 'address', tone: 'pc', off: -6 },
  { id: 'prog-ir', from: 'program', to: 'ir', label: 'instruction', tone: 'ir', off: 6 },
  { id: 'cu-pc', from: 'cu', to: 'pc', label: 'PC + 1', tone: 'cu', off: 0 },
  { id: 'ir-cu', from: 'ir', to: 'cu', label: 'decode', tone: 'cu', off: 0 },
  { id: 'cu-alu', from: 'cu', to: 'alu', label: 'maths job', tone: 'alu', off: 0 },
  { id: 'cu-lsu', from: 'cu', to: 'lsu', label: 'memory job', tone: 'lsu', off: 0 },
  { id: 'alu-regs', from: 'alu', to: 'regs', label: 'result', tone: 'alu', off: 0 },
  { id: 'lsu-regs', from: 'lsu', to: 'regs', label: 'data', tone: 'lsu', off: 0 },
  { id: 'cu-regs', from: 'cu', to: 'regs', label: 'value', tone: 'cu', off: 0 },
  { id: 'lsu-desk', from: 'lsu', to: 'desk', label: 'ask the Desk', tone: 'lsu', off: 0 },
  { id: 'desk-ram', from: 'desk', to: 'ram', label: 'on a miss', tone: 'desk', off: 0 },
  { id: 'lsu-ram', from: 'lsu', to: 'ram', label: 'no cache', tone: 'ram', off: 0 },
];

function activeWires(v, cacheOn) {
  const s = new Set();
  if (!v) return s;
  if (v.kind === 'fetch') { s.add('pc-prog'); s.add('prog-ir'); }
  if (v.kind === 'pc-update' && v.reason !== 'jump-not-taken') s.add('cu-pc');
  if (v.kind === 'decode') {
    s.add('ir-cu');
    if (v.unit === 'ALU') s.add('cu-alu');
    if (v.unit === 'LSU') s.add('cu-lsu');
  }
  if (v.kind === 'execute' && v.unit === 'LSU') {
    if (cacheOn) { s.add('lsu-desk'); if (v.access !== 'hit') s.add('desk-ram'); } else s.add('lsu-ram');
  }
  if (v.kind === 'writeback') {
    if (v.unit === 'ALU') s.add('alu-regs');
    if (v.unit === 'CU' && v.target === 'register') s.add('cu-regs');
    if (v.unit === 'LSU' && v.target === 'register') s.add('lsu-regs');
    if (v.unit === 'LSU' && v.target === 'memory') s.add(cacheOn ? 'lsu-desk' : 'lsu-ram');
  }
  return s;
}

const rel = (r, o) => ({ x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height });
const ctr = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
// The point where a ray from the centre of rectangle r toward `to` leaves r.
function edgePoint(r, to) {
  const c = ctr(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const k = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * k, y: c.y + dy * k };
}

// Thin lines between the parts. They are drawn UNDER the parts, so they look
// like wires that run behind the components. The brighter line is the one in use.
function Wires({ stageRef, anchors, active }) {
  const [paths, setPaths] = useState([]);
  const lastSig = useRef('');

  const compute = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    const out = [];
    WIRES.forEach((w) => {
      const a = anchors.current[w.from];
      const b = anchors.current[w.to];
      if (!a || !b) return;
      const ra = rel(a.getBoundingClientRect(), sr);
      const rb = rel(b.getBoundingClientRect(), sr);
      let ca = ctr(ra);
      let cb = ctr(rb);
      const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
      const nx = (-(cb.y - ca.y) / len) * w.off;
      const ny = ((cb.x - ca.x) / len) * w.off;
      ca = { x: ca.x + nx, y: ca.y + ny };
      cb = { x: cb.x + nx, y: cb.y + ny };
      const p1 = edgePoint(ra, cb);
      const p2 = edgePoint(rb, ca);
      out.push({ ...w, x1: ca.x, y1: ca.y, x2: p2.x, y2: p2.y, sx: p1.x, sy: p1.y });
    });
    const sig = JSON.stringify(out.map((o) => [o.id, Math.round(o.x1), Math.round(o.y1), Math.round(o.x2), Math.round(o.y2)]));
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      setPaths(out);
    }
  }, [stageRef, anchors]);

  useLayoutEffect(() => { compute(); });
  useEffect(() => {
    window.addEventListener('resize', compute);
    let ro;
    if (typeof ResizeObserver !== 'undefined' && stageRef.current) {
      ro = new ResizeObserver(compute);
      ro.observe(stageRef.current);
    }
    return () => {
      window.removeEventListener('resize', compute);
      if (ro) ro.disconnect();
    };
  }, [compute, stageRef]);

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 5 }} aria-hidden="true">
      {paths.map((w) => {
        const on = active.has(w.id);
        const color = on ? TONES[w.tone].hex : '#94a3b8';
        const ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
        const hx = w.x2 - 10 * Math.cos(ang);
        const hy = w.y2 - 10 * Math.sin(ang);
        const head = `${w.x2},${w.y2} ${hx + 5 * Math.sin(ang)},${hy - 5 * Math.cos(ang)} ${hx - 5 * Math.sin(ang)},${hy + 5 * Math.cos(ang)}`;
        return (
          <g key={w.id} opacity={on ? 1 : 0.5}>
            <line x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} stroke={color} strokeWidth={on ? 3 : 1.5} strokeDasharray={on ? undefined : '4 4'} />
            <polygon points={head} fill={color} />
            {on && (
              <text
                x={(w.sx + w.x2) / 2} y={(w.sy + w.y2) / 2 - 6} textAnchor="middle" fontSize="12" fontWeight="600"
                fill={color} stroke="#f8fafc" strokeWidth="4" paintOrder="stroke"
              >
                {w.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* -------------------------------------------------------------- flights --- */
// What flies where during each phase. Times are fractions of the phase length.
function flightsFor(v) {
  if (!v) return [];
  switch (v.kind) {
    case 'fetch':
      return [
        { from: 'pc', to: `pl-${v.pc}`, text: `line ${v.pc}`, tone: 'pc', delay: 0, dur: 0.35 },
        { from: `pl-${v.pc}`, to: 'ir', text: v.text, tone: 'ir', delay: 0.4, dur: 0.5 },
      ];
    case 'pc-update':
      if (v.reason === 'jump-not-taken') return [];
      return [{ from: 'cu', to: 'pc', text: v.reason === 'sequential' ? '+ 1' : `go to ${v.to}`, tone: 'cu', delay: 0, dur: 0.6 }];
    case 'decode': {
      const f = [{ from: 'ir', to: 'cu', text: v.op, tone: 'cu', delay: 0, dur: 0.4 }];
      if (v.unit === 'ALU') f.push({ from: 'cu', to: 'alu', text: 'maths job', tone: 'alu', delay: 0.5, dur: 0.4 });
      if (v.unit === 'LSU') f.push({ from: 'cu', to: 'lsu', text: 'memory job', tone: 'lsu', delay: 0.5, dur: 0.4 });
      return f;
    }
    case 'execute':
      if (v.unit === 'ALU') {
        return [
          { from: `r${v.aReg}`, to: 'alu', text: String(v.a), tone: 'reg', delay: 0, dur: 0.4 },
          v.bReg !== null
            ? { from: `r${v.bReg}`, to: 'alu', text: String(v.b), tone: 'reg', delay: 0.1, dur: 0.4 }
            : { from: 'cu', to: 'alu', text: String(v.b), tone: 'cu', delay: 0.1, dur: 0.4 },
        ];
      }
      if (v.unit === 'LSU') {
        const ask = v.op === 'LOAD' ? `cell ${v.address}?` : `write ${v.value}`;
        const f = [];
        if (v.cacheOn === false) {
          f.push({ from: 'lsu', to: 'ram', text: ask, tone: 'lsu', delay: 0, dur: 0.3 });
          f.push({ from: 'ram', to: 'lsu', text: v.op === 'LOAD' ? `value ${v.value}` : 'saved', tone: 'ram', delay: 0.55, dur: 0.35 });
          return f;
        }
        f.push({ from: 'lsu', to: 'desk', text: ask, tone: 'lsu', delay: 0, dur: 0.2 });
        if (v.access === 'hit') {
          if (v.op === 'LOAD') f.push({ from: 'desk', to: 'lsu', text: `value ${v.value}`, tone: 'desk', delay: 0.4, dur: 0.3 });
        } else {
          f.push({ from: 'desk', to: 'ram', text: 'not here', tone: 'desk', delay: 0.22, dur: 0.22 });
          f.push({ from: 'ram', to: 'desk', text: `box: cells ${v.start}-${v.end}`, tone: 'ram', delay: 0.5, dur: 0.3 });
          if (v.op === 'LOAD') f.push({ from: 'desk', to: 'lsu', text: `value ${v.value}`, tone: 'desk', delay: 0.84, dur: 0.14 });
        }
        return f;
      }
      return [];
    case 'writeback':
      if (v.target === 'register') {
        const tone = v.unit === 'ALU' ? 'alu' : v.unit === 'LSU' ? 'lsu' : 'cu';
        const from = v.unit === 'ALU' ? 'alu' : v.unit === 'LSU' ? 'lsu' : 'cu';
        return [{ from, to: `r${v.regIndex}`, text: String(v.newValue), tone, delay: 0, dur: 0.5 }];
      }
      if (v.target === 'memory') return [{ from: 'lsu', to: `cell-${v.address}`, text: String(v.newValue), tone: 'lsu', delay: 0, dur: 0.6 }];
      return [];
    default:
      return [];
  }
}

/* -------------------------------------------------------------- captions -- */
function captionFor(v) {
  switch (v.kind) {
    case 'fetch':
      return `Fetch: the PC says ${v.pc}, so the CPU reads line ${v.pc} of the program, "${v.text}", and copies it into the IR.`;
    case 'pc-update':
      if (v.reason === 'sequential') return `PC + 1: the PC moves from ${v.from} to ${v.to}, ready for the next instruction.`;
      if (v.reason === 'jump-taken') return `Jump: the PC is set to ${v.to}, so the program goes back to line ${v.to}.`;
      return `No jump: the PC stays at ${v.to} and the program carries on.`;
    case 'decode':
      return `Decode: the Control Unit splits "${v.text}" into its parts and works out what to do. ${v.route}`;
    case 'execute':
      if (v.unit === 'ALU') {
        return `Execute: the ALU works out ${v.aLabel} ${v.symbol} ${v.bLabel}, which is ${v.a} ${v.symbol} ${v.b} = ${v.result}.`;
      }
      if (v.unit === 'CU' && v.op === 'MOV') {
        return `Execute: the Control Unit picks up the value ${v.value}${v.srcLabel !== String(v.value) ? ` from ${v.srcLabel}` : ''}.`;
      }
      if (v.unit === 'CU') {
        return v.taken
          ? `Execute: ${v.regName} is ${v.regValue}, which is not zero, so the CPU will jump back to line ${v.target}.`
          : `Execute: ${v.regName} is 0, so the CPU will not jump.`;
      }
      return lsuCaption(v);
    case 'writeback':
      if (v.target === 'register') return `Write-back: ${v.name} changes from ${v.oldValue} to ${v.newValue}.`;
      if (v.target === 'memory') return `Write-back: memory cell ${v.address} changes from ${v.oldValue} to ${v.newValue}.`;
      return 'Write-back: nothing to store. The jump already changed the PC.';
    default:
      return v.message;
  }
}

function lsuCaption(v) {
  const verb = v.op === 'LOAD' ? 'reads' : 'writes';
  if (v.access === 'hit') {
    return `Execute: the memory helper ${verb} cell ${v.address}. Its box (cells ${v.start} to ${v.end}) is already on the Desk, so this takes only ${v.latency} ticks.`;
  }
  if (v.access === 'uncached') {
    return `Execute: the cache is switched off, so the memory helper must walk to the Warehouse every time: ${v.latency} ticks. The ALU has nothing to do while it waits.`;
  }
  const evicted = v.evictedTag !== null ? ` The Desk was full, so the box that was used longest ago (box ${v.evictedTag}) was removed.` : '';
  return `Execute: cell ${v.address} is not on the Desk. The memory helper walks to the Warehouse (${v.latency} ticks) and brings back the whole box, cells ${v.start} to ${v.end}. The ALU has nothing to do while it waits.${evicted}`;
}

/* ----------------------------------------------------------------- hooks -- */
function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const h = () => setReduced(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return reduced;
}

// Moves the machine on by one phase.
function advanceRun(run, instrs) {
  let { machine, exec } = run;
  if (exec && exec.idx < exec.phases.length - 1) return { machine, exec: { ...exec, idx: exec.idx + 1 } };
  if (exec) { machine = exec.phases[exec.phases.length - 1].snap; exec = null; }
  if (isFinished(machine, instrs)) return { machine, exec: null };
  const { phases } = stepInstruction(machine, instrs);
  return phases.length ? { machine, exec: { phases, idx: 0 } } : { machine, exec: null };
}

/* ------------------------------------------------------------ small parts - */
function Unit({ id, reg, tone, title, status, active, children, className = '' }) {
  const t = TONES[tone];
  return (
    <div
      ref={reg(id)}
      className={`relative border-l-4 bg-white p-3 shadow-sm ${t.edge} ${active ? `ring-2 ${t.ring}` : 'ring-1 ring-slate-200'} ${className}`}
      style={{ zIndex: 10 }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className={`text-sm font-semibold ${t.ink}`}>{title}</h3>
        {status && <span className={`flex items-center gap-1 text-xs font-semibold ${t.ink}`}>{status}</span>}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- app -- */
export default function App() {
  const reduced = useReducedMotion();

  // The program and the memory the user can change (inputs).
  const [appliedText, setAppliedText] = useState(PRESETS[0].code);
  const [draft, setDraft] = useState(PRESETS[0].code);
  const [editing, setEditing] = useState(false);
  const [initialMem, setInitialMem] = useState(defaultMemory);
  const [cacheOn, setCacheOn] = useState(true);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const program = useMemo(() => parseProgram(appliedText), [appliedText]);
  const instrs = program.instrs;
  const draftCheck = useMemo(() => (editing ? parseProgram(draft) : null), [editing, draft]);

  // View preferences
  const [speed, setSpeed] = useState(1);
  const [bigView, setBigView] = useState(false);
  const [cardPos, setCardPos] = useState('bottom');

  // The simulation. `exec` holds the phases of the instruction being shown.
  const [run, setRun] = useState(() => ({ machine: createMachine({ memory: defaultMemory(), cacheEnabled: true }), exec: null }));
  const { machine, exec } = run;
  const [playing, setPlaying] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [details, setDetails] = useState(false);
  const [selectedCell, setSelectedCell] = useState(null);
  const [cellDraft, setCellDraft] = useState('');
  const [tests, setTests] = useState(null);

  const view = exec ? exec.phases[exec.idx] : null;
  const snap = view ? view.snap : machine;
  const lastIdx = exec ? exec.phases.length - 1 : 0;
  const done = exec ? exec.idx === lastIdx && isFinished(exec.phases[lastIdx].snap, instrs) : isFinished(machine, instrs);
  const decoded = exec && exec.idx >= 2 && exec.phases[2] && exec.phases[2].kind === 'decode' ? exec.phases[2] : null;
  const runningLine = exec && exec.phases[0].kind === 'fetch' ? exec.phases[0].pc : null;
  const lsuExec = view && view.kind === 'execute' && view.unit === 'LSU' ? { ...view, cacheOn } : null;

  const resetRun = useCallback((mem, on) => {
    setRun({ machine: createMachine({ memory: mem, cacheEnabled: on }), exec: null });
    setPlaying(false);
  }, []);

  const advance = useCallback(() => setRun((prev) => advanceRun(prev, instrs)), [instrs]);

  const nextInstruction = () =>
    setRun((prev) => {
      let { machine: m, exec: e } = prev;
      if (e && e.idx < e.phases.length - 1) return { machine: m, exec: { ...e, idx: e.phases.length - 1 } };
      if (e) { m = e.phases[e.phases.length - 1].snap; e = null; }
      if (isFinished(m, instrs)) return { machine: m, exec: null };
      const { phases } = stepInstruction(m, instrs);
      return phases.length ? { machine: m, exec: { phases, idx: phases.length - 1 } } : { machine: m, exec: null };
    });

  const skipToEnd = () => {
    setPlaying(false);
    setRun((prev) => {
      const m = prev.exec ? prev.exec.phases[prev.exec.phases.length - 1].snap : prev.machine;
      return { machine: runToEnd(m, instrs), exec: null };
    });
  };

  const flush = () =>
    setRun((prev) => {
      const m = prev.exec ? prev.exec.phases[prev.exec.phases.length - 1].snap : prev.machine;
      return { machine: flushCache(m), exec: null };
    });

  const runAgainWarm = () => {
    setPlaying(false);
    setRun({ machine: rerunWarm(snap), exec: null });
  };

  const applyProgram = (text, id) => {
    const parsed = parseProgram(text);
    if (!parsed.ok) return false;
    setAppliedText(text);
    setDraft(text);
    setPresetId(id || 'custom');
    setEditing(false);
    resetRun(initialMem, cacheOn);
    return true;
  };

  const toggleCache = (on) => {
    setCacheOn(on);
    resetRun(initialMem, on);
  };

  const setCell = (addr, raw) => {
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return;
    const mem = initialMem.slice();
    mem[addr] = v;
    setInitialMem(mem);
    resetRun(mem, cacheOn);
  };

  // Autoplay: wait for the length of the current phase, then step.
  useEffect(() => {
    if (!playing) return undefined;
    if (done) { setPlaying(false); return undefined; }
    const t = setTimeout(advance, phaseDuration(view) / speed);
    return () => clearTimeout(t);
  }, [playing, run, speed, done, advance, view]);

  // Tick counter: counts up through the real latency during EXECUTE.
  const [shownTicks, setShownTicks] = useState(0);
  useEffect(() => {
    const target = snap.cycles;
    if (view && view.kind === 'execute' && view.cyclesAfter > view.cyclesBefore && !reduced) {
      const from = view.cyclesBefore;
      const dur = (phaseDuration(view) * 0.8) / speed;
      let raf;
      let t0;
      const tick = (t) => {
        if (t0 === undefined) t0 = t;
        const p = Math.min(1, (t - t0) / dur);
        setShownTicks(Math.round(from + (target - from) * p));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      setShownTicks(from);
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    setShownTicks(target);
    return undefined;
  }, [view, snap.cycles, speed, reduced]);

  // During a miss the Desk shows its OLD contents until the box has arrived.
  const [post, setPost] = useState(true);
  useLayoutEffect(() => {
    if (lsuExec && lsuExec.access !== 'hit' && !reduced) {
      setPost(false);
      const t = setTimeout(() => setPost(true), (phaseDuration(view) * 0.62) / speed);
      return () => clearTimeout(t);
    }
    setPost(true);
    return undefined;
  }, [view, speed, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  const deskSnap = lsuExec && lsuExec.snapPre && !post ? lsuExec.snapPre : snap;

  // Anchors, wires and flying chips.
  const stageRef = useRef(null);
  const overlayRef = useRef(null);
  const anchors = useRef({});
  const flights = useRef([]);
  const reg = (id) => (el) => {
    if (el) anchors.current[id] = el;
    else delete anchors.current[id];
  };

  useEffect(() => {
    const clear = () => {
      flights.current.forEach((f) => { try { f.anim.cancel(); } catch (e) { /* already finished */ } f.el.remove(); });
      flights.current = [];
    };
    clear();
    const overlay = overlayRef.current;
    if (!view || reduced || !overlay || !overlay.animate) return clear;
    const total = phaseDuration(view) / speed;
    const specs = flightsFor(lsuExec || view);
    const or = overlay.getBoundingClientRect();
    const find = (id) => anchors.current[id] || (id.startsWith('pl-') ? anchors.current.program : null);

    specs.forEach((sp) => {
      const A = find(sp.from);
      const B = find(sp.to);
      if (!A || !B) return;
      const pa = ctr(rel(A.getBoundingClientRect(), or));
      const pb = ctr(rel(B.getBoundingClientRect(), or));
      const el = document.createElement('div');
      el.className = `flight-chip ${bigView ? 'flight-chip--big' : ''}`;
      el.textContent = sp.text;
      el.style.background = TONES[sp.tone].hex;
      overlay.appendChild(el);
      const maxScale = bigView ? 1.4 : 1;
      const at = (p, s) => `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${s})`;
      const anim = el.animate(
        [
          { transform: at(pa, 0.6 * maxScale), opacity: 0 },
          { transform: at(pa, 1 * maxScale), opacity: 1, offset: 0.12 },
          { transform: at(pb, 1 * maxScale), opacity: 1, offset: 0.88 },
          { transform: at(pb, 0.6 * maxScale), opacity: 0 },
        ],
        { duration: Math.max(250, sp.dur * total), delay: sp.delay * total, easing: 'ease-in-out', fill: 'both' },
      );
      anim.onfinish = () => el.remove();
      flights.current.push({ el, anim });
    });
    return clear;
  }, [view, speed, bigView]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------- derived views -- */
  const stage = stripId(view);
  const wires = activeWires(lsuExec || view, cacheOn);
  const ex = view && view.kind === 'execute' ? view : null;
  const wb = view && view.kind === 'writeback' ? view : null;

  const caption = view
    ? captionFor(lsuExec || view)
    : done
      ? snap.error || 'The program has finished. See the summary below, or press Reset to watch it again.'
      : `Ready. The CPU will run line ${snap.pc} first: "${instrs[snap.pc].text}" (${glossLine(instrs[snap.pc])}). Press Next step and read this bar: it explains every move.`;

  const summary = summarize(snap);
  const other = useMemo(() => {
    if (!done || !program.ok || snap.error) return null;
    return runToEnd(createMachine({ memory: initialMem, cacheEnabled: !cacheOn }), instrs).cycles;
  }, [done, program.ok, snap.error, initialMem, cacheOn, instrs]);

  const accessedLine = lsuExec ? lsuExec.line : null;
  const cacheLines = deskSnap.cache.lines;
  const onDesk = (line) => cacheOn && cacheLines.some((l) => l.valid && l.tag === line);
  const oldestTag = (() => {
    const v = cacheLines.filter((l) => l.valid);
    if (v.length < 2) return null;
    return v.reduce((a, b) => (b.lastUsed < a.lastUsed ? b : a)).tag;
  })();

  /* ------------------------------------------------- Big View Formatting -- */
  const stageIdx = STRIP.findIndex((s) => s.id === stage);
  let bigNumbers = null;

  if (view) {
    switch (view.kind) {
      case 'fetch':
        bigNumbers = <div className="text-3xl font-bold">PC: {view.pc} &rarr; <code className="text-amber-900">"{view.text}"</code></div>;
        break;
      case 'pc-update':
        bigNumbers = <div className="text-4xl font-bold">{view.from} &rarr; {view.to}</div>;
        break;
      case 'decode':
        bigNumbers = (
          <div className="space-y-4">
            <ul className="flex flex-wrap gap-4 text-xl">
              {view.parts.map((p, i) => (
                <li key={i}><code className="font-bold text-violet-900">{p.text}</code>: {p.meaning}</li>
              ))}
            </ul>
            <p className="text-2xl font-bold text-violet-900">{view.route}</p>
          </div>
        );
        break;
      case 'execute':
        if (view.unit === 'ALU') {
          bigNumbers = (
            <div className="text-center">
              <div className="text-2xl text-slate-600 font-mono">{view.aLabel} {view.symbol} {view.bLabel}</div>
              <div className="mt-2 text-[40px] font-bold font-mono text-orange-900">{view.a} {view.symbol} {view.b} = {view.result}</div>
            </div>
          );
        } else if (view.unit === 'CU') {
          if (view.op === 'MOV') {
            bigNumbers = <div className="text-[32px] font-bold text-violet-900">Value: {view.value}</div>;
          } else {
            bigNumbers = <div className="text-[32px] font-bold text-violet-900">{view.regName} is {view.regValue} &rarr; {view.taken ? 'JUMP' : 'NO JUMP'}</div>;
          }
        } else if (view.unit === 'LSU' && lsuExec) {
          bigNumbers = (
            <div className="text-2xl">
              <div>Address: <strong>{lsuExec.addrLabel}</strong></div>
              {lsuExec.access === 'uncached' ? (
                <div className="mt-2 text-[32px] font-bold text-blue-900">No cache: {lsuExec.latency} ticks</div>
              ) : (
                <>
                  <div className="mt-1">Box {lsuExec.line}, cells {lsuExec.start} to {lsuExec.end}</div>
                  <div className="mt-2 text-[32px] font-bold text-blue-900">{lsuExec.access === 'hit' ? 'HIT' : 'MISS'}, {lsuExec.latency} ticks</div>
                </>
              )}
            </div>
          );
        }
        break;
      case 'writeback':
        if (view.target === 'register') {
          bigNumbers = <div className="text-4xl font-bold">{view.name}: <span className="text-slate-500 font-normal">{view.oldValue} &rarr;</span> {view.newValue}</div>;
        } else if (view.target === 'memory') {
          bigNumbers = <div className="text-4xl font-bold">Cell {view.address}: <span className="text-slate-500 font-normal">{view.oldValue} &rarr;</span> {view.newValue}</div>;
        } else {
          bigNumbers = <div className="text-3xl font-bold text-slate-500">Nothing to store</div>;
        }
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------ rendering -- */
  const aluStatus = (() => {
    if (view && view.kind === 'decode' && view.unit === 'ALU') return { s: 'Job received', b: `Next job: ${view.op}` };
    if (ex && ex.unit === 'ALU') return { s: 'Working', b: null };
    if (wb && wb.unit === 'ALU') return { s: 'Done', b: `Result ${wb.newValue} goes to ${wb.name}` };
    if (ex && ex.unit === 'LSU') return { s: <><Clock className="h-3.5 w-3.5" aria-hidden="true" /> Idle: waiting for data</>, b: 'The ALU can do nothing until the memory answers.' };
    return { s: 'Idle', b: 'No maths job right now.' };
  })();

  const cuBody = (() => {
    if (!view) return <p className="mt-2 text-xs text-slate-600">Waiting for an instruction.</p>;
    if (view.kind === 'decode') {
      return (
        <div className="mt-2 space-y-1.5">
          <ul className="space-y-1">
            {view.parts.map((p, i) => (
              <li key={i} className="flex gap-2 text-xs leading-snug">
                <code className="min-w-[3.2rem] rounded bg-violet-100 px-1.5 py-0.5 font-bold text-violet-900">{p.text}</code>
                <span className="text-slate-700">{p.meaning.replace(/^[^=]*= /, '')}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs font-semibold text-violet-900">{view.route}</p>
        </div>
      );
    }
    let t = 'Waiting for an instruction.';
    if (view.kind === 'fetch') t = 'Waiting for the instruction to arrive in the IR.';
    else if (view.kind === 'pc-update') t = view.reason === 'sequential' ? 'Adding 1 to the PC.' : view.reason === 'jump-taken' ? `Setting the PC to ${view.to}.` : 'Leaving the PC alone.';
    else if (ex && ex.unit === 'CU' && ex.op === 'MOV') t = `Passing the value ${ex.value} on to ${ex.dest}.`;
    else if (ex && ex.unit === 'CU') t = `Checking ${ex.regName}: it is ${ex.regValue}, so ${ex.taken ? 'jump.' : 'no jump.'}`;
    else if (ex) t = `Waiting for the ${ex.unit} to finish.`;
    else if (wb) t = 'Instruction finished.';
    return (
      <div className="mt-2">
        {decoded && <p className="text-xs text-slate-600">Working on: <code className="font-bold text-violet-900">{decoded.text}</code></p>}
        <p className="mt-1 text-xs font-semibold text-violet-900">{t}</p>
      </div>
    );
  })();

  const lsuBody = (() => {
    if (view && view.kind === 'decode' && view.unit === 'LSU') return <p className="mt-2 text-xs text-slate-700">Job received: {view.op}.</p>;
    if (lsuExec) {
      return (
        <div className="mt-2 space-y-0.5 text-xs text-slate-800">
          <p>Address: <b>{lsuExec.addrLabel}</b></p>
          <p>Box {lsuExec.line}, cells {lsuExec.start} to {lsuExec.end}</p>
          <p className="font-semibold text-blue-900">
            {lsuExec.access === 'hit' ? `On the Desk: hit, ${lsuExec.latency} ticks`
              : lsuExec.access === 'miss' ? `Not on the Desk: miss, ${lsuExec.latency} ticks`
                : `No cache: ${lsuExec.latency} ticks`}
          </p>
        </div>
      );
    }
    if (wb && wb.unit === 'LSU') return <p className="mt-2 text-xs text-slate-700">Delivered {wb.newValue}.</p>;
    return <p className="mt-2 text-xs text-slate-600">Idle: no memory job.</p>;
  })();

  const execLine = runningLine !== null ? runningLine : done ? null : snap.pc;

  return (
    <div
      className="min-h-screen bg-slate-100 text-slate-900"
      style={{ paddingBottom: bigView && cardPos === 'bottom' ? '42vh' : 0, paddingTop: bigView && cardPos === 'top' ? '42vh' : 0 }}
    >
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="font-serif text-2xl font-semibold">CPU in slow motion</h1>
            <p className="max-w-2xl text-sm text-slate-600">
              Watch what a CPU really does with every instruction. Each step is computed by a simulator as you go, not played back from a recording.
            </p>
          </div>
          <a href="/guide" target="_blank" rel="noopener" className="text-sm font-semibold text-blue-700 hover:underline">Assembly guide</a>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-3 px-4 py-4">
        {showIntro && (
          <section className="border-l-4 border-blue-700 bg-white p-4">
            <h2 className="text-base font-semibold">How to read this page</h2>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-slate-800">
              <li>A CPU runs a program one instruction at a time. Every instruction goes through the same five steps: <b>Fetch, PC + 1, Decode, Execute, Write-back</b>.</li>
              <li>Press <b>Next step</b> and read the sentence under the buttons. Watch the registers: they really change.</li>
              <li>Most instructions take 1 tick. Reading memory can take 100 ticks, unless the data is already on the <b>Desk</b> (the cache). Try switching the cache off at the end.</li>
            </ol>
            <div className="mt-2 flex items-center gap-4">
              <button type="button" className={btnPlain} onClick={() => setShowIntro(false)}>Got it</button>
              <a href="/guide" target="_blank" rel="noopener" className="text-sm font-medium text-blue-700 hover:underline">Assembly guide: what instructions exist?</a>
            </div>
          </section>
        )}

        {/* controls */}
        <div className="flex flex-wrap items-center gap-2 border border-slate-300 bg-white p-2">
          <button type="button" className={btnPrimary} onClick={() => { setPlaying(false); advance(); }} disabled={done && !exec}>
            <StepForward className="h-4 w-4" aria-hidden="true" /> Next step
          </button>
          <button type="button" className={btnPlain} onClick={() => { setPlaying(false); nextInstruction(); }} disabled={done && !exec}>
            Next instruction
          </button>
          <button type="button" className={btnPlain} onClick={() => setPlaying((p) => !p)} disabled={done}>
            {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" className={btnPlain} onClick={skipToEnd} disabled={done}>
            <SkipForward className="h-4 w-4" aria-hidden="true" /> Skip to the end
          </button>
          <button type="button" className={btnPlain} onClick={() => resetRun(initialMem, cacheOn)}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset
          </button>
          <span className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />
          <label className="flex items-center gap-1.5 text-sm">
            Speed
            <select
              className="rounded border border-slate-400 bg-white px-1.5 py-1 text-sm"
              value={speed}
              onChange={(e) => {
                const s = Number(e.target.value);
                setSpeed(s);
                if (s === 0.25) setBigView(true);
              }}
            >
              {[0.25, 0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s === 0.25 ? '0.25x slow motion' : `${s}x`}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={bigView} onChange={(e) => setBigView(e.target.checked)} />
            Big view (pop-up explanations)
          </label>
          <span className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={cacheOn} onChange={(e) => toggleCache(e.target.checked)} />
            Desk (cache) on
          </label>
          <button type="button" className={btnPlain} onClick={flush} disabled={!cacheOn}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Empty the Desk
          </button>
          <span className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />
          <label className="flex items-center gap-1.5 text-sm">
            Program
            <select
              className="rounded border border-slate-400 bg-white px-1.5 py-1 text-sm"
              value={presetId}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.id === e.target.value);
                if (p) applyProgram(p.code, p.id);
              }}
            >
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              {presetId === 'custom' && <option value="custom">My own program</option>}
            </select>
          </label>
        </div>

        {/* narration + five steps */}
        <section aria-live="polite" className="border-l-4 border-slate-900 bg-white px-4 py-3">
          <p className="font-serif text-lg leading-snug">{caption}</p>
        </section>
        <ol className="flex flex-wrap gap-2" aria-label="The five steps of an instruction">
          {STRIP.map((s, i) => {
            const on = s.id === stage;
            return (
              <li
                key={s.id}
                className={`flex items-center gap-2 border px-3 py-1 text-sm ${on ? 'border-slate-900 bg-slate-900 font-semibold text-white' : stageIdx > i ? 'border-slate-400 bg-white text-slate-800' : 'border-slate-300 bg-white text-slate-500'}`}
                aria-current={on ? 'step' : undefined}
              >
                <span className="font-mono text-xs">{i + 1}</span>{s.label}
              </li>
            );
          })}
        </ol>

        {/* the diagram */}
        <div ref={stageRef} className="relative isolate">
          <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_310px]">
            {/* Program */}
            <section ref={reg('program')} className="relative self-start border border-slate-400 bg-white p-3" aria-label="Program">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Program</h2>
                {!editing && (
                  <button type="button" className={btnPlain} onClick={() => { setDraft(appliedText); setEditing(true); }}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-600">Instructions are read from here, not from the cache. Reading them is free. <a href="/guide" target="_blank" rel="noopener" className="text-blue-700 hover:underline">What do these instructions mean?</a></p>
              {!editing ? (
                <ol className="mt-2 space-y-1">
                  {instrs.map((ins, i) => {
                    const cur = i === execLine;
                    return (
                      <li
                        key={i}
                        ref={reg(`pl-${i}`)}
                        className={`relative border p-1.5 ${cur ? 'border-amber-600 bg-amber-50' : 'border-slate-200 bg-white'}`}
                        style={{ zIndex: 10 }}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span><span className="mr-2 font-mono text-xs text-slate-500">{i}</span><code className="text-sm font-bold">{ins.text}</code></span>
                          {cur && <span className="text-xs font-semibold text-amber-900">{runningLine !== null ? 'running' : 'next'}</span>}
                        </div>
                        <p className="pl-5 text-xs text-slate-600">{glossLine(ins)}</p>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="mt-2">
                  <label className="text-xs font-semibold" htmlFor="prog-edit">One instruction per line. Text after ; is a comment.</label>
                  <textarea
                    id="prog-edit" rows={9} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)}
                    className="mt-1 w-full border border-slate-400 bg-white p-2 font-mono text-xs"
                  />
                  <p className="mt-1 text-xs text-slate-600">MOV R0, 5 | LOAD R1, [4] | STORE R1, [8] | ADD R0, R1 | SUB R0, 1 | JNZ R0, 2. Registers R0 to R3, memory cells 0 to 63.</p>
                  {draftCheck && draftCheck.errors.length > 0 && (
                    <ul className="mt-2 space-y-1 border-l-4 border-red-600 bg-red-50 p-2 text-xs text-red-900" role="alert">
                      {draftCheck.errors.map((er, i) => <li key={i}>{er.line ? `Line ${er.line}: ` : ''}{er.message}</li>)}
                    </ul>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button type="button" className={btnPrimary} onClick={() => applyProgram(draft, 'custom')} disabled={!draftCheck || !draftCheck.ok}>Run this program</button>
                    <button type="button" className={btnPlain} onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </section>

            {/* CPU + Desk */}
            <div className="space-y-6">
              <section className="relative border border-slate-400 bg-slate-50 p-3" aria-label="CPU">
                <h2 className="text-base font-semibold">CPU <span className="text-sm font-normal text-slate-600">the part that runs the instructions</span></h2>

                <div className="mt-2 grid grid-cols-1 gap-3 border border-slate-300 bg-white/70 p-2 sm:grid-cols-[190px_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <Unit id="pc" reg={reg} tone="pc" title="PC" status={view && (view.kind === 'pc-update' || view.kind === 'fetch') ? 'in use' : ''} active={view && (view.kind === 'pc-update' || view.kind === 'fetch')}>
                      <p className="text-xs text-slate-600">Program counter: which line is next</p>
                      <p className="font-mono text-xl font-bold text-amber-900">{snap.pc}</p>
                    </Unit>
                    <Unit id="ir" reg={reg} tone="ir" title="IR" status={view && (view.kind === 'fetch' || view.kind === 'decode') ? 'in use' : ''} active={view && (view.kind === 'fetch' || view.kind === 'decode')}>
                      <p className="text-xs text-slate-600">Instruction register: the instruction being run</p>
                      <p className="min-h-[1.75rem] font-mono text-base font-bold text-teal-900">{snap.ir || '(empty)'}</p>
                    </Unit>
                  </div>
                  <div ref={reg('regs')} className="relative self-start border border-slate-300 bg-white p-2" style={{ zIndex: 10 }}>
                    <h3 className="text-sm font-semibold text-slate-800">Registers <span className="text-xs font-normal text-slate-600">tiny, instant storage</span></h3>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[0, 1, 2, 3].map((n) => {
                        const changed = wb && wb.target === 'register' && wb.regIndex === n;
                        return (
                          <div key={`${n}-${changed ? snap.cycles : ''}`} ref={reg(`r${n}`)} className={`border border-slate-300 p-2 ${changed ? 'reg-flash ring-2 ring-slate-600' : ''}`}>
                            <div className="flex items-baseline justify-between"><span className="text-xs font-semibold">R{n}</span>{changed && <span className="text-xs font-semibold text-slate-900">changed</span>}</div>
                            <p className="font-mono text-lg font-bold">{snap.regs[n]}</p>
                            {changed && <p className="font-mono text-xs text-slate-700">{wb.oldValue} → {wb.newValue}</p>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="mt-8 grid gap-4 md:grid-cols-3">
                  <Unit id="alu" reg={reg} tone="alu" title="ALU" status={aluStatus.s} active={!!ex && ex.unit === 'ALU' || (!!wb && wb.unit === 'ALU')}>
                    <p className="text-xs text-slate-600">Arithmetic logic unit: does the maths</p>
                    {ex && ex.unit === 'ALU' ? (
                      <div className="mt-1">
                        <p className="font-mono text-xs text-slate-800">{ex.aLabel} {ex.symbol} {ex.bLabel}</p>
                        <p className="font-mono text-lg font-bold text-orange-900">{ex.a} {ex.symbol} {ex.b} = {ex.result}</p>
                      </div>
                    ) : <p className="mt-2 text-xs text-slate-700">{aluStatus.b}</p>}
                  </Unit>
                  <Unit id="cu" reg={reg} tone="cu" title="Control Unit" status={view && ['decode', 'pc-update'].includes(view.kind) || (ex && ex.unit === 'CU') ? 'in use' : ''} active={!!view && (['decode', 'pc-update'].includes(view.kind) || (!!ex && ex.unit === 'CU'))}>
                    <p className="text-xs text-slate-600">CU: reads the instruction and gives the orders</p>
                    {cuBody}
                  </Unit>
                  <Unit id="lsu" reg={reg} tone="lsu" title="Memory helper" status={lsuExec || (wb && wb.unit === 'LSU') ? 'in use' : ''} active={!!lsuExec || (!!wb && wb.unit === 'LSU')}>
                    <p className="text-xs text-slate-600">LSU: fetches and saves data</p>
                    {lsuBody}
                  </Unit>
                </div>
              </section>

              {/* Desk */}
              <section ref={reg('desk')} className="relative border border-emerald-700 bg-white p-3" style={{ zIndex: 10 }} aria-label="Desk (cache)">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold text-emerald-900">Desk (cache) <span className="text-sm font-normal text-slate-600">small and fast: {CONFIG.hitLatency} ticks</span></h2>
                  <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} /> Show valid bit, tag and LRU</label>
                </div>
                {!cacheOn ? (
                  <p className="mt-2 text-sm text-slate-700">The Desk is switched off. Every memory access walks to the Warehouse ({CONFIG.missLatency} ticks).</p>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-slate-600">{CONFIG.cacheLines} slots. Each slot holds one whole box of {CONFIG.lineSize} cells. When full, the box used longest ago leaves.</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {cacheLines.map((l, i) => {
                        const hot = lsuExec && post && lsuExec.slot === i;
                        return (
                          <div key={i} className={`border p-2 ${hot ? 'border-emerald-700 bg-emerald-50 ring-2 ring-emerald-600' : 'border-slate-300 bg-white'}`}>
                            <div className="flex items-baseline justify-between">
                              <span className="text-xs font-semibold">Slot {i}</span>
                              {hot && <span className="text-xs font-bold text-emerald-900">{lsuExec.access === 'hit' ? 'HIT' : 'MISS: box arrived'}</span>}
                            </div>
                            {l.valid ? (
                              <>
                                <p className="text-xs text-slate-700">Box {l.tag}: cells {hex(l.tag * CONFIG.lineSize)} to {hex(l.tag * CONFIG.lineSize + CONFIG.lineSize - 1)}</p>
                                <div className="mt-1 grid grid-cols-4 gap-0.5">
                                  {[0, 1, 2, 3].map((k) => <span key={k} className="border border-emerald-200 bg-emerald-50 text-center font-mono text-xs">{deskSnap.mem[l.tag * CONFIG.lineSize + k]}</span>)}
                                </div>
                                {details && (
                                  <p className="mt-1 text-xs text-slate-600">Valid = 1, Tag = {l.tag}, last used #{l.lastUsed}{l.tag === oldestTag ? ' (leaves first)' : ''}</p>
                                )}
                              </>
                            ) : (
                              <p className="mt-1 text-xs text-slate-500">empty{details ? ' (Valid = 0)' : ''}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            </div>

            {/* Warehouse */}
            <section ref={reg('ram')} className="relative self-start border border-stone-500 bg-white p-3" style={{ zIndex: 10 }} aria-label="Warehouse (RAM)">
              <h2 className="text-base font-semibold text-stone-900">Warehouse (RAM) <span className="text-sm font-normal text-slate-600">big and slow: {CONFIG.missLatency} ticks</span></h2>
              <p className="mt-1 text-xs text-slate-600">{CONFIG.memSize} cells in boxes of {CONFIG.lineSize}. The CPU never takes just one cell: it takes the whole box. Click a cell to change its value.</p>
              <div className="mt-2 space-y-0.5">
                {Array.from({ length: CONFIG.memSize / CONFIG.lineSize }, (_, line) => {
                  const isAcc = accessedLine === line;
                  const tag = isAcc ? (lsuExec.access === 'hit' ? 'HIT' : lsuExec.access === 'miss' ? (post ? 'MISS' : 'MISS') : 'no cache') : onDesk(line) ? 'on Desk' : '';
                  const boxLit = isAcc && lsuExec.access === 'miss' && post;
                  return (
                    <div key={line} className={`grid grid-cols-[40px_repeat(4,minmax(0,1fr))_58px] items-center gap-0.5 ${isAcc ? 'bg-blue-50' : ''}`}>
                      <span className="font-mono text-xs text-slate-500">{hex(line * CONFIG.lineSize)}</span>
                      {[0, 1, 2, 3].map((k) => {
                        const a = line * CONFIG.lineSize + k;
                        const target = lsuExec && lsuExec.address === a;
                        return (
                          <button
                            key={a} type="button" ref={reg(`cell-${a}`)}
                            onClick={() => { setSelectedCell(a); setCellDraft(String(initialMem[a])); }}
                            aria-label={`Memory cell ${a}, value ${snap.mem[a]}. Click to change it.`}
                            className={`h-5 border text-center font-mono text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${target ? 'border-blue-700 bg-blue-200 font-bold' : boxLit ? 'border-emerald-600 bg-emerald-100' : onDesk(line) ? 'border-emerald-300 bg-emerald-50' : 'border-slate-300 bg-white'} ${selectedCell === a ? 'ring-2 ring-slate-900' : ''}`}
                          >
                            {snap.mem[a]}
                          </button>
                        );
                      })}
                      <span className={`text-xs ${isAcc ? 'font-bold text-blue-900' : 'text-emerald-800'}`}>{tag}</span>
                    </div>
                  );
                })}
              </div>
              {selectedCell !== null && (
                <form
                  className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-300 pt-2"
                  onSubmit={(e) => { e.preventDefault(); setCell(selectedCell, cellDraft); }}
                >
                  <label className="text-xs" htmlFor="cell-edit">Cell {selectedCell} =</label>
                  <input id="cell-edit" type="number" min="0" max="65535" value={cellDraft} onChange={(e) => setCellDraft(e.target.value)} className="w-20 border border-slate-400 px-1 py-0.5 text-sm" />
                  <button type="submit" className={btnPrimary}>Set and restart</button>
                  <button type="button" className={btnPlain} onClick={() => setSelectedCell(null)}>Close</button>
                </form>
              )}
            </section>
          </div>
          <div ref={overlayRef} className="pointer-events-none absolute inset-0" style={{ zIndex: 50 }} aria-hidden="true" />
          <Wires stageRef={stageRef} anchors={anchors} active={wires} />
        </div>

        {/* numbers */}
        <section className="grid gap-3 md:grid-cols-3" aria-label="Measurements">
          <div className="border border-slate-300 bg-white p-3">
            <p className="text-sm text-slate-600">Ticks so far (one tick = one step of the CPU clock)</p>
            <p className="font-mono text-4xl font-bold tabular-nums">{shownTicks}</p>
          </div>
          <div className="border border-slate-300 bg-white p-3">
            <p className="text-sm text-slate-600">Where the ticks went</p>
            <div className="mt-1 flex h-5 w-full overflow-hidden border border-slate-400" role="img" aria-label={`${summary.memWait} ticks waiting for memory out of ${summary.ticks}`}>
              <div className="bg-amber-500" style={{ width: `${summary.ticks ? (100 * summary.memWait) / summary.ticks : 0}%` }} />
              <div className="flex-1 bg-slate-200" />
            </div>
            <p className="mt-1 text-sm">Waiting for memory: <b>{summary.memWait}</b> ticks. Everything else: <b>{summary.ticks - summary.memWait}</b> ticks.</p>
          </div>
          <div className="border border-slate-300 bg-white p-3">
            <p className="text-sm text-slate-600">Desk results</p>
            <p className="text-sm">Hits (found on the Desk): <b>{summary.hits}</b></p>
            <p className="text-sm">Misses (walk to the Warehouse): <b>{summary.misses}</b></p>
            {!cacheOn && <p className="text-sm">Accesses with the Desk off: <b>{summary.uncached}</b></p>}
          </div>
        </section>

        {done && !snap.error && (
          <section className="border-l-4 border-emerald-700 bg-white p-4" aria-label="Summary">
            <h2 className="text-base font-semibold">The program finished in {summary.ticks} ticks</h2>
            <p className="mt-1 text-sm leading-relaxed">
              {summary.memWait > 0
                ? `${summary.memWait} of those ticks (${summary.waitPct}%) were spent waiting for memory.`
                : 'This program never touched memory, so the CPU never had to wait.'}
              {other !== null && summary.ticks !== other && ` From a cold start, the same program takes ${other} ticks with the Desk ${cacheOn ? 'switched off' : 'switched on'}.`}
              {other !== null && summary.ticks === other && ' The Desk makes no difference here, because this program does not read or write memory.'}
            </p>
            {summary.memWait > 0 && cacheOn && (
              <button type="button" className={`${btnPrimary} mt-2`} onClick={runAgainWarm}>Run it again with the Desk still full</button>
            )}
          </section>
        )}

        <details
          className="border border-slate-300 bg-white p-3 text-sm"
          onToggle={(e) => { if (e.currentTarget.open && !tests) setTests(runSelfTests()); }}
        >
          <summary className="cursor-pointer font-semibold">Check the simulator (self-test)</summary>
          {tests && (
            <>
              <p className="mt-2">{tests.every((t) => t.pass) ? `All ${tests.length} checks pass.` : 'Some checks failed.'} These run in your browser against numbers worked out by hand.</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead><tr className="border-b border-slate-300"><th className="py-1 pr-2">Check</th><th className="pr-2">Expected</th><th className="pr-2">Got</th><th className="pr-2">Result</th></tr></thead>
                  <tbody>
                    {tests.map((t) => (
                      <tr key={t.name} className="border-b border-slate-100 align-top">
                        <td className="py-1 pr-2">{t.name}<div className="text-slate-500">{t.why}</div></td>
                        <td className="pr-2 font-mono">{t.expected}</td>
                        <td className="pr-2 font-mono">{t.actual}</td>
                        <td className="pr-2 font-semibold">{t.pass ? 'PASS' : 'FAIL'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </details>

        <footer className="pb-6 text-xs leading-relaxed text-slate-600">
          <p className="font-semibold text-slate-800">What is simplified</p>
          <p>
            Instructions come from a separate program list and cost no extra ticks. The five steps of a simple instruction all happen inside its one tick; they are shown slowly so you can follow them.
            One cache level with {CONFIG.cacheLines} slots, least-recently-used replacement; writes go straight through to memory.
            The delays (1, {CONFIG.hitLatency} and {CONFIG.missLatency} ticks) are illustrative, but their proportions are realistic. Nothing is saved: reload the page and everything resets.
          </p>
        </footer>
      </main>

      {/* Feature: Big view (pop-up explanations) */}
      {bigView && (
        <div
          aria-hidden="true"
          className={`fixed z-50 flex flex-col gap-4 overflow-y-auto border-4 border-slate-900 bg-white p-6 shadow-2xl transition-all ${cardPos === 'bottom' ? 'bottom-0' : 'top-0'}`}
          style={{ left: '50%', transform: 'translateX(-50%)', width: 'min(760px, 100vw - 2rem)', maxHeight: '40vh' }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm font-bold uppercase tracking-wider text-slate-500">
              {view ? `Step ${stageIdx + 1} of 5: Fetch | PC + 1 | Decode | Execute | Write-back` : (done ? 'Finished' : 'Ready')}
            </div>
            <div className="flex shrink-0 gap-2">
              <button type="button" className={btnPlain} onClick={() => setCardPos(cardPos === 'bottom' ? 'top' : 'bottom')}>
                Move to {cardPos === 'bottom' ? 'top' : 'bottom'}
              </button>
              <button type="button" className={btnPlain} onClick={() => setBigView(false)}>
                Hide pop-ups
              </button>
            </div>
          </div>

          <p className="font-serif text-[18px] leading-snug text-slate-900">{caption}</p>

          {view && bigNumbers && (
            <div className="rounded border border-slate-200 bg-slate-50 p-5">
              {bigNumbers}
            </div>
          )}

          <div className="text-right font-mono text-xl font-bold text-slate-700">
            Tick counter: {shownTicks}
          </div>
        </div>
      )}
    </div>
  );
}
