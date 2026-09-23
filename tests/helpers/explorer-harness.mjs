// Runs the vendored DNA explorer's loader under Node against one embedded store and prints
// how much of each tree it rendered. Taken from tps-project-dna's check_explorer_compat.py
// (v2.18.1), whose harness this is, so the page is exercised the way its own authors do.
//
// Usage: node explorer-harness.mjs <explorer.html> <payload.json>
import fs from 'node:fs';
const UI = process.argv[2], PAYLOAD = process.argv[3];
const html = fs.readFileSync(UI, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const ui = blocks.find(b => b.includes('function load()')) || blocks[blocks.length - 1];

const els = {};
const mkel = () => ({ addEventListener(){}, textContent:'', innerHTML:'', value:'', checked:false,
  style:{}, disabled:false, title:'', dataset:{}, children:[], click(){}, remove(){},
  appendChild(){}, querySelector:()=>null, querySelectorAll:()=>[], scrollIntoView(){},
  getContext:()=>({ measureText:()=>({width:10}), font:'' }),
  classList:{ toggle(){}, add(){}, remove(){}, contains:()=>false } });
const el = id => (els[id] ??= Object.assign(mkel(), { id }));
globalThis.window = globalThis;
globalThis.document = { body: Object.assign(mkel(), {}), documentElement: mkel(),
  createElement: mkel, addEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[],
  getElementById: el };
globalThis.$ = el;
globalThis.history = { pushState(){}, replaceState(){} };
globalThis.location = { pathname: '/explorer.html', hash: '' };
globalThis.addEventListener = () => {};
globalThis.alert = () => {};
globalThis.setTimeout = (f) => { try { typeof f === 'function' && f(); } catch(e){} return 0; };
globalThis.clearTimeout = () => {};
globalThis.requestAnimationFrame = (f) => { f(); return 0; };
globalThis.URL = { createObjectURL: () => 'x', revokeObjectURL(){} };
globalThis.Blob = class {};
// No fetch: an embedded store must never reach for the network. If the loader falls back to
// fetch for a collection the payload omits, that is a real defect on the exported file — where
// there is no server to answer — so it fails loudly here instead of silently rendering nothing.
globalThis.fetch = async () => { throw new Error('FETCH_ATTEMPTED (embed should be self-sufficient)'); };
// Real console errors must surface. Stubbing this to a no-op once made a page-breaking failure
// report as an empty message, because the harness swallowed the only report of it.
const errs = [];
globalThis.console = { log(){}, warn(){}, error(...a){ errs.push(a.map(String).join(' ')); },
                       info(){}, debug(){} };

globalThis.__DNA_EMBED = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));

const src = ui.replace(/\nload\(\);\s*$/, '\n') + '\nreturn typeof load === "function" ? load : null;';
let loader;
try { loader = new Function(src)(); }
catch (e) { console.log; process.stderr.write('PAGE_SYNTAX: ' + e.message + '\n'); process.exit(4); }
if (!loader) { process.stderr.write('NO_LOADER\n'); process.exit(3); }
try { await loader(); }
catch (e) { process.stderr.write('THREW: ' + (e && e.message || e) + '\n'); process.exit(1); }

// rendered-nothing is a failure too: a loader that swallows every row raises nothing at all
const rendered = ['capTree', 'procTree'].map(id => (els[id]?.innerHTML || '').length);
process.stdout.write(JSON.stringify({ rendered, errs }) + '\n');
