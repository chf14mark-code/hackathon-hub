/* /Guide.jsx */
import React, { useState } from 'react';
import { parseProgram, createMachine, stepInstruction, rerunWarm, summarize, defaultMemory, isFinished } from './engine.js';

function TryItWidget({ defaultCode, defaultRegs = [0, 0, 0, 0], defaultMemOverrides = {} }) {
  const id = React.useId();
  const [code, setCode] = useState(defaultCode);
  const [regs, setRegs] = useState(defaultRegs);
  
  const initialMem = defaultMemory();
  for (let i = 0; i < 16; i++) {
    if (defaultMemOverrides[i] !== undefined) initialMem[i] = defaultMemOverrides[i];
  }
  const [mem, setMem] = useState(initialMem.slice(0, 16));
  const [cacheOn, setCacheOn] = useState(true);
  const [runState, setRunState] = useState(null);

  const reset = () => {
    setCode(defaultCode);
    setRegs(defaultRegs);
    const m = defaultMemory();
    for (let i = 0; i < 16; i++) {
      if (defaultMemOverrides[i] !== undefined) m[i] = defaultMemOverrides[i];
    }
    setMem(m.slice(0, 16));
    setCacheOn(true);
    setRunState(null);
  };

  const runSim = (warmPrevious = null) => {
    const parsed = parseProgram(code);
    if (!parsed.ok) {
      setRunState({ error: parsed.errors.map(e => (e.line ? `Line ${e.line}: ` : '') + e.message).join(' | ') });
      return;
    }

    let m;
    if (warmPrevious) {
      m = rerunWarm(warmPrevious);
      m.regs = [...regs]; 
    } else {
      const fullMem = defaultMemory();
      for (let i = 0; i < 16; i++) fullMem[i] = mem[i];
      m = createMachine({ memory: fullMem, cacheEnabled: cacheOn });
      m.regs = [...regs];
    }

    const trace = [];
    let s = m;
    let steps = 0;
    while (!isFinished(s, parsed.instrs) && steps < 20) {
      const line = s.pc;
      const text = parsed.instrs[line].text;
      const res = stepInstruction(s, parsed.instrs);
      const state = res.state;
      if (state.error) {
        setRunState({ error: state.error });
        return;
      }
      const ex = res.phases.find(p => p.kind === 'execute' && p.unit === 'LSU');
      const hitMiss = ex ? (ex.access === 'hit' ? 'HIT' : ex.access === 'miss' ? 'MISS' : 'no cache') : '-';
      trace.push({
        line,
        text,
        regsAfter: [...state.regs],
        pcAfter: state.pc,
        ticks: state.cycles,
        hitMiss,
      });
      s = state;
      steps++;
    }

    setRunState({ trace, snap: s, stopped: steps === 20 && !isFinished(s, parsed.instrs), summary: summarize(s) });
  };

  const setReg = (i, val) => {
    const v = parseInt(val, 10);
    const newRegs = [...regs];
    newRegs[i] = isNaN(v) ? 0 : v;
    setRegs(newRegs);
  };

  const setCell = (i, val) => {
    const v = parseInt(val, 10);
    const newMem = [...mem];
    newMem[i] = isNaN(v) ? 0 : v;
    setMem(newMem);
  };

  const btn = 'inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-40';
  const btnPrimary = `${btn} border-slate-900 bg-slate-900 text-white hover:bg-slate-700`;
  const btnPlain = `${btn} border-slate-400 bg-white text-slate-900 hover:bg-slate-100`;

  return (
    <div className="border border-slate-300 bg-slate-50 p-4 space-y-4">
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div>
          <label className="block text-sm font-semibold mb-1" htmlFor={`${id}-code`}>Program</label>
          <textarea
            id={`${id}-code`}
            className="w-full border border-slate-400 p-2 font-mono text-sm bg-white"
            rows={4}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div>
          <div className="text-sm font-semibold mb-1">Initial state</div>
          <div className="flex gap-2 mb-2">
            {[0, 1, 2, 3].map(i => (
              <label key={i} className="flex flex-col text-xs font-semibold">
                R{i}
                <input type="number" className="w-16 border border-slate-400 p-1 font-mono font-normal bg-white" value={regs[i]} onChange={e => setReg(i, e.target.value)} />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-sm font-semibold mt-4">
            <input type="checkbox" checked={cacheOn} onChange={e => setCacheOn(e.target.checked)} className="h-4 w-4" />
            Desk (cache) on
          </label>
        </div>
      </div>
      
      <div>
        <div className="text-sm font-semibold mb-1">Mini RAM (cells 0-15)</div>
        <div className="flex flex-wrap gap-4">
          {[0, 1, 2, 3].map(box => (
            <div key={box} className="border border-slate-300 bg-white p-2">
              <div className="text-xs text-slate-500 mb-1">Box {box}</div>
              <div className="grid grid-cols-4 gap-1">
                {[0, 1, 2, 3].map(k => {
                  const a = box * 4 + k;
                  return (
                    <label key={a} className="flex flex-col items-center text-xs font-semibold">
                      {a}
                      <input type="number" className="w-11 border border-slate-300 p-0.5 text-center font-mono font-normal" value={mem[a]} onChange={e => setCell(a, e.target.value)} />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} onClick={() => runSim(null)}>Run</button>
        <button type="button" className={btnPlain} onClick={() => runSim(runState?.snap)} disabled={!runState?.snap}>Run again with the Desk still full</button>
        <button type="button" className={btnPlain} onClick={reset}>Reset</button>
      </div>

      {runState && (
        <div className="border border-slate-300 bg-white p-3 space-y-3 mt-4">
          {runState.error ? (
            <div className="text-red-900 border-l-4 border-red-600 bg-red-50 p-2 text-sm" role="alert">{runState.error}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th className="pr-4 py-1">Line</th>
                      <th className="pr-4">Instruction</th>
                      <th className="pr-4">Registers after</th>
                      <th className="pr-4">PC after</th>
                      <th className="pr-4">Ticks</th>
                      <th>HIT/MISS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runState.trace.map((t, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="pr-4 py-1">{t.line}</td>
                        <td className="pr-4 font-mono text-slate-800">{t.text}</td>
                        <td className="pr-4 font-mono">{t.regsAfter.join(' ')}</td>
                        <td className="pr-4 font-mono">{t.pcAfter}</td>
                        <td className="pr-4 tabular-nums">{t.ticks}</td>
                        <td>{t.hitMiss}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {runState.stopped && <div className="text-xs text-slate-500 mt-1">stopped after 20 steps</div>}
              </div>
              
              <div className="flex flex-wrap gap-6 text-sm mt-2">
                <div>
                  <div className="font-semibold mb-1">Registers</div>
                  <div className="flex gap-3">
                    {[0, 1, 2, 3].map(i => {
                      const changed = runState.snap.regs[i] !== regs[i];
                      return (
                        <div key={i} className="text-center">
                          <div className="font-mono text-base">{runState.snap.regs[i]}</div>
                          <div className={`text-xs ${changed ? 'text-amber-700 font-bold' : 'text-slate-400'}`}>{changed ? 'changed' : `R${i}`}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                
                <div>
                  <div className="font-semibold mb-1">Summary</div>
                  <div className="text-slate-700">Total ticks: <b>{runState.summary.ticks}</b> | Hits: <b>{runState.summary.hits}</b> | Misses: <b>{runState.summary.misses}</b></div>
                </div>
              </div>

              <div className="mt-2">
                <div className="font-semibold mb-1 text-sm">Mini RAM (0-15) after run</div>
                <div className="flex flex-wrap gap-2 text-sm">
                  {[0, 1, 2, 3].map(box => {
                    const onDesk = runState.snap.cache.enabled && runState.snap.cache.lines.some(l => l.valid && l.tag === box);
                    return (
                      <div key={box} className={`border p-1 ${onDesk ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300 bg-slate-50'}`}>
                        <div className="flex gap-1">
                          {[0, 1, 2, 3].map(k => {
                            const a = box * 4 + k;
                            const changed = runState.snap.mem[a] !== mem[a];
                            return (
                              <div key={a} className="flex flex-col items-center px-1">
                                <div className="font-mono">{runState.snap.mem[a]}</div>
                                <div className="h-4 flex items-center justify-center">
                                  {changed && <span className="text-[10px] text-amber-700 font-bold leading-none">changed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="h-4 flex items-center justify-center border-t border-slate-200 mt-1">
                          {onDesk && <span className="text-[10px] text-emerald-800 font-bold leading-none uppercase">on Desk</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Guide() {
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-4">
      <main className="mx-auto max-w-[1000px] space-y-6 bg-white p-6 md:p-8 shadow">
        <a href="/" className="inline-block text-blue-700 font-semibold hover:underline">&larr; Back to the simulator</a>
        
        <header>
          <h1 className="text-3xl font-serif font-bold">Assembly guide: the 6 instructions</h1>
          <p className="mt-4 text-base leading-relaxed text-slate-800">
            Assembly is made of the tiny instructions a CPU understands, each with an opcode (what to do) and operands (what to do it to). In this simulator, there are registers R0-R3, memory cells 0-63 in boxes of 4, and ticks to measure time. There are no flags and no stack in this simulator.
          </p>
        </header>

        <section className="bg-slate-50 border border-slate-200 p-4">
          <h2 className="text-lg font-semibold mb-2">How to read an operand</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm text-slate-800">
            <li><b>R0-R3</b>: A register (tiny, instant storage).</li>
            <li><b>0-65535</b>: A plain number. Hexadecimal like <code>0x1F</code> is allowed.</li>
            <li><b>[4]</b>: Memory cell 4.</li>
            <li><b>[R2]</b>: The memory cell whose address is currently stored in R2.</li>
          </ul>
          <p className="mt-3 text-sm text-slate-700">
            Memory cells are handled in boxes of 4 because the CPU fetches a whole box from the Warehouse to the Desk at once.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">Instruction Cheat-sheet</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-200">
                  <th className="border border-slate-300 p-2 font-semibold">Group</th>
                  <th className="border border-slate-300 p-2 font-semibold">Opcode</th>
                  <th className="border border-slate-300 p-2 font-semibold">What it does</th>
                  <th className="border border-slate-300 p-2 font-semibold">Operands</th>
                  <th className="border border-slate-300 p-2 font-semibold">Ticks</th>
                  <th className="border border-slate-300 p-2 font-semibold">Example</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-slate-300 p-2 font-medium" rowSpan={3}>Data transfer</td>
                  <td className="border border-slate-300 p-2"><a href="#inst-MOV" className="text-blue-700 font-bold hover:underline">MOV</a></td>
                  <td className="border border-slate-300 p-2">Put a value into a register</td>
                  <td className="border border-slate-300 p-2">Rd, reg|number</td>
                  <td className="border border-slate-300 p-2">1</td>
                  <td className="border border-slate-300 p-2 font-mono">MOV R0, 5</td>
                </tr>
                <tr>
                  <td className="border border-slate-300 p-2"><a href="#inst-LOAD" className="text-blue-700 font-bold hover:underline">LOAD</a></td>
                  <td className="border border-slate-300 p-2">Read a memory cell into a register</td>
                  <td className="border border-slate-300 p-2">Rd, [number|reg]</td>
                  <td className="border border-slate-300 p-2">3 or 100</td>
                  <td className="border border-slate-300 p-2 font-mono">LOAD R1, [4]</td>
                </tr>
                <tr>
                  <td className="border border-slate-300 p-2"><a href="#inst-STORE" className="text-blue-700 font-bold hover:underline">STORE</a></td>
                  <td className="border border-slate-300 p-2">Write a register into a memory cell</td>
                  <td className="border border-slate-300 p-2">Rs, [number|reg]</td>
                  <td className="border border-slate-300 p-2">3 or 100</td>
                  <td className="border border-slate-300 p-2 font-mono">STORE R1, [8]</td>
                </tr>
                <tr>
                  <td className="border border-slate-300 p-2 font-medium" rowSpan={2}>Arithmetic</td>
                  <td className="border border-slate-300 p-2"><a href="#inst-ADD" className="text-blue-700 font-bold hover:underline">ADD</a></td>
                  <td className="border border-slate-300 p-2">Add two numbers</td>
                  <td className="border border-slate-300 p-2">Rd, reg|number</td>
                  <td className="border border-slate-300 p-2">1</td>
                  <td className="border border-slate-300 p-2 font-mono">ADD R0, R1</td>
                </tr>
                <tr>
                  <td className="border border-slate-300 p-2"><a href="#inst-SUB" className="text-blue-700 font-bold hover:underline">SUB</a></td>
                  <td className="border border-slate-300 p-2">Subtract a number</td>
                  <td className="border border-slate-300 p-2">Rd, reg|number</td>
                  <td className="border border-slate-300 p-2">1</td>
                  <td className="border border-slate-300 p-2 font-mono">SUB R0, 1</td>
                </tr>
                <tr>
                  <td className="border border-slate-300 p-2 font-medium">Control flow</td>
                  <td className="border border-slate-300 p-2"><a href="#inst-JNZ" className="text-blue-700 font-bold hover:underline">JNZ</a></td>
                  <td className="border border-slate-300 p-2">Jump if not zero</td>
                  <td className="border border-slate-300 p-2">Rs, line number</td>
                  <td className="border border-slate-300 p-2">1</td>
                  <td className="border border-slate-300 p-2 font-mono">JNZ R0, 2</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div className="h-px bg-slate-300 my-8"></div>

        <section id="inst-MOV" className="space-y-4">
          <h2 className="text-2xl font-bold"><span className="text-blue-700">MOV</span> &mdash; Put a value into a register</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border border-slate-200">
              <thead className="bg-slate-100">
                <tr><th className="p-2 border-b">Pos</th><th className="p-2 border-b">Accepts</th><th className="p-2 border-b">Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td className="p-2 border-b">1</td><td className="p-2 border-b font-mono text-slate-700">Rd</td><td className="p-2 border-b">The register that receives the answer</td></tr>
                <tr><td className="p-2 border-b">2</td><td className="p-2 border-b font-mono text-slate-700">reg | number</td><td className="p-2 border-b">The register to read, or a plain number</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm"><b>Changes:</b> Registers (R0-R3). Flags: none.</p>
          <p className="text-sm"><b>Cost:</b> 1 tick.</p>
          <div className="text-sm bg-red-50 text-red-900 p-3 border-l-4 border-red-600">
            <b>Common mistakes:</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>Operand 1 of MOV is not valid. Example: "MOV R0, 5".</li>
              <li>MOV needs 2 operands, like "MOV R0, 5".</li>
            </ul>
          </div>
          <TryItWidget defaultCode="MOV R0, 5" />
        </section>

        <section id="inst-LOAD" className="space-y-4 pt-8 border-t border-slate-200">
          <h2 className="text-2xl font-bold"><span className="text-blue-700">LOAD</span> &mdash; Read a memory cell into a register</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border border-slate-200">
              <thead className="bg-slate-100">
                <tr><th className="p-2 border-b">Pos</th><th className="p-2 border-b">Accepts</th><th className="p-2 border-b">Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td className="p-2 border-b">1</td><td className="p-2 border-b font-mono text-slate-700">Rd</td><td className="p-2 border-b">The register that receives the answer</td></tr>
                <tr><td className="p-2 border-b">2</td><td className="p-2 border-b font-mono text-slate-700">[number] | [reg]</td><td className="p-2 border-b">The memory address to read</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm"><b>Changes:</b> Registers (R0-R3). Flags: none.</p>
          <p className="text-sm"><b>Cost:</b> 3 ticks if the box is on the Desk, 100 if not.</p>
          <div className="text-sm bg-red-50 text-red-900 p-3 border-l-4 border-red-600">
            <b>Common mistakes:</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>Operand 2 of LOAD is not valid. Example: "LOAD R1, [4]".</li>
              <li>Address 64 is outside memory (0 to 63).</li>
            </ul>
          </div>
          <TryItWidget defaultCode="LOAD R1, [4]" />
        </section>

        <section id="inst-STORE" className="space-y-4 pt-8 border-t border-slate-200">
          <h2 className="text-2xl font-bold"><span className="text-blue-700">STORE</span> &mdash; Write a register into a memory cell</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border border-slate-200">
              <thead className="bg-slate-100">
                <tr><th className="p-2 border-b">Pos</th><th className="p-2 border-b">Accepts</th><th className="p-2 border-b">Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td className="p-2 border-b">1</td><td className="p-2 border-b font-mono text-slate-700">Rs</td><td className="p-2 border-b">The register to save</td></tr>
                <tr><td className="p-2 border-b">2</td><td className="p-2 border-b font-mono text-slate-700">[number] | [reg]</td><td className="p-2 border-b">The memory address to write to</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm"><b>Changes:</b> Memory. Flags: none.</p>
          <p className="text-sm"><b>Cost:</b> 3 ticks if the box is on the Desk, 100 if not.</p>
          <div className="text-sm bg-red-50 text-red-900 p-3 border-l-4 border-red-600">
            <b>Common mistakes:</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>STORE needs 2 operands, like "STORE R1, [8]".</li>
              <li>Operand 1 of STORE is not valid. Example: "STORE R1, [8]".</li>
            </ul>
          </div>
          <TryItWidget defaultCode="STORE R1, [8]" defaultRegs={[0, 7, 0, 0]} />
        </section>

        <section id="inst-ADD" className="space-y-4 pt-8 border-t border-slate-200">
          <h2 className="text-2xl font-bold"><span className="text-blue-700">ADD</span> &mdash; Add two numbers</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border border-slate-200">
              <thead className="bg-slate-100">
                <tr><th className="p-2 border-b">Pos</th><th className="p-2 border-b">Accepts</th><th className="p-2 border-b">Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td className="p-2 border-b">1</td><td className="p-2 border-b font-mono text-slate-700">Rd</td><td className="p-2 border-b">The register that receives the answer, and provides the first number</td></tr>
                <tr><td className="p-2 border-b">2</td><td className="p-2 border-b font-mono text-slate-700">reg | number</td><td className="p-2 border-b">The second number to add</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm"><b>Changes:</b> Registers (R0-R3). Flags: none.</p>
          <p className="text-sm"><b>Cost:</b> 1 tick.</p>
          <div className="text-sm bg-red-50 text-red-900 p-3 border-l-4 border-red-600">
            <b>Common mistakes:</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>The number 99999 is too big (max 65535).</li>
              <li>Operand 2 of ADD is not valid. Example: "ADD R0, R1".</li>
            </ul>
          </div>
          <TryItWidget defaultCode="ADD R0, R1" defaultRegs={[2, 3, 0, 0]} />
        </section>

        <section id="inst-SUB" className="space-y-4 pt-8 border-t border-slate-200">
          <h2 className="text-2xl font-bold"><span className="text-blue-700">SUB</span> &mdash; Subtract a number</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border border-slate-200">
              <thead className="bg-slate-100">
                <tr><th className="p-2 border-b">Pos</th><th className="p-2 border-b">Accepts</th><th className="p-2 border-b">Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td className="p-2 border-b">1</td><td className="p-2 border-b font-mono text-slate-700">Rd</td><td className="p-2 border-b">The register that receives the answer, and provides the first number</td></tr>
                <tr><td className="p-2 border-b">2</td><td className="p-2 border-b font-mono text-slate-700">reg | number</td><td className="p-2 border-b">The number to subtract</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm"><b>Changes:</b> Registers (R0-R3). Flags: none.</p>
          <p className="text-sm"><b>Cost:</b> 1 tick.</p>
          <div className="text-sm bg-red-50 text-red-900 p-3 border-l-4 border-red-600">
            <b>Common mistakes:</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>SUB needs 2 operands, like "SUB R0, 1".</li>
              <li>Operand 1 of SUB is not valid. Example: "SUB R0, 1".</li>
            </ul>
          </div>
          <TryItWidget defaultCode="SUB R0, 1" defaultRegs={[5, 0, 0, 0]} />
        </section>

        <section id="inst-JNZ" className="space-y-4 pt-8 border-t border-slate-200">
          <h2 className="text-2xl font-bold"><span className="text-blue-700">JNZ</span> &mdash; Jump if not zero</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border border-slate-200">
              <thead className="bg-slate-100">
                <tr><th className="p-2 border-b">Pos</th><th className="p-2 border-b">Accepts</th><th className="p-2 border-b">Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td className="p-2 border-b">1</td><td className="p-2 border-b font-mono text-slate-700">Rs</td><td className="p-2 border-b">The register to check</td></tr>
                <tr><td className="p-2 border-b">2</td><td className="p-2 border-b font-mono text-slate-700">number</td><td className="p-2 border-b">The program line to jump to</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm"><b>Changes:</b> PC (Program Counter). Flags: none.</p>
          <p className="text-sm"><b>Cost:</b> 1 tick.</p>
          <div className="text-sm bg-red-50 text-red-900 p-3 border-l-4 border-red-600">
            <b>Common mistakes:</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>JNZ jumps to line 99, but the program only has lines 0 to 1.</li>
              <li>Operand 1 of JNZ is not valid. Example: "JNZ R0, 2".</li>
            </ul>
          </div>
          <TryItWidget defaultCode={'SUB R0, 1\nJNZ R0, 0'} defaultRegs={[3, 0, 0, 0]} />
        </section>

        <section className="space-y-6 pt-8 border-t border-slate-200">
          <h2 className="text-2xl font-bold">Compare and jump in this simulator</h2>
          <p className="text-sm text-slate-800">There is no CMP or JMP instruction. Here is how you do it:</p>
          
          <div className="bg-slate-50 p-4 border border-slate-200 space-y-4">
            <h3 className="text-lg font-semibold">1. Compare two numbers</h3>
            <p className="text-sm">
              R0 becomes 0 when they are equal; JNZ jumps only when R0 is not 0. In this example, R2 = 1 means "equal". 
              SUB changes R0, so copy it first if you need the original.
            </p>
            <TryItWidget defaultCode={'MOV R0, 5\nMOV R1, 5\nSUB R0, R1\nJNZ R0, 5\nMOV R2, 1\nMOV R3, 9'} />
          </div>

          <div className="bg-slate-50 p-4 border border-slate-200 space-y-4">
            <h3 className="text-lg font-semibold">2. Always jump</h3>
            <p className="text-sm">
              R3 is never 0, so the jump always happens and line 2 is skipped.
            </p>
            <TryItWidget defaultCode={'MOV R3, 1\nJNZ R3, 3\nMOV R0, 99\nMOV R1, 7'} />
          </div>
        </section>

        <div className="pt-8 text-center">
          <a href="/" className="inline-block text-blue-700 font-semibold hover:underline">Back to the simulator</a>
        </div>
      </main>
    </div>
  );
}
