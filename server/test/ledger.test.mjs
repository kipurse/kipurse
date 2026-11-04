import test from 'node:test';import assert from 'node:assert/strict';import {classify,withBalances} from '../src/v5/ledger.mjs';
const W='0x1000000000000000000000000000000000000001',V='0x1000000000000000000000000000000000000002',O='0x1000000000000000000000000000000000000003',PM='0xc0de9762a5f06d7f98293b77d74230c750cba078',AD='0xc7d7c8b03e94576bc3c99a7e37827e07f7d9a4e8';
const u=n=>BigInt(Math.round(n*1e6));
// The real Base mainnet history of 2026-10-21 (tx hashes shortened).
const X=[{tx:'0x6219',block:1,t:1,li:0,from:O,to:W,value:u(10)},
 {tx:'0x8f33',block:2,t:2,li:0,from:V,to:PM,value:u(0.01758)},{tx:'0x8f33',block:2,t:2,li:1,from:PM,to:V,value:u(0.010475)},
 {tx:'0x737e',block:3,t:3,li:0,from:V,to:PM,value:u(0.020085)},{tx:'0x737e',block:3,t:3,li:1,from:W,to:AD,value:u(0.02673)},{tx:'0x737e',block:3,t:3,li:2,from:AD,to:V,value:u(0.02672)},
 {tx:'0x737e',block:3,t:3,li:3,from:V,to:O,value:u(0.01)},{tx:'0x737e',block:3,t:3,li:4,from:PM,to:V,value:u(0.011522)}];
test('ledger: real 10-21 history -> deposit, vault gas, payment (+settle), balances match chain',()=>{
  const rows=classify(X,{wallet:W,vault:V,paymasters:[PM],names:{[O.toLowerCase()]:'你的 Base Account'}});
  assert.deepEqual(rows.map(r=>[r.tx,r.account,r.kind,r.delta]),[['0x6219','wallet','deposit','10000000'],['0x8f33','vault','gas','-7105'],['0x737e','wallet','payment','-26730'],['0x737e','vault','settle','8157']]);
  assert.equal(rows[0].zh,'充值（来自 你的 Base Account）');assert.equal(rows[2].zh,'AI 付款 0.01 给 你的 Base Account（含手续费和手续费 0.01673）');
  const {rows:b,opening}=withBalances(rows,{wallet:'14103220',vault:'191437'});
  assert.equal(opening.wallet,'4129950');assert.equal(opening.vault,'190385');assert.deepEqual(b.map(r=>r.balance),['14129950','183280','14103220','191437']);});
test('ledger: plain withdrawal and vault top-up',()=>{const rows=classify([{tx:'a',block:1,t:1,li:0,from:W,to:O,value:5n},{tx:'b',block:2,t:2,li:0,from:O,to:V,value:7n}],{wallet:W,vault:V,paymasters:[PM]});
  assert.deepEqual(rows.map(r=>[r.account,r.kind,r.delta]),[['wallet','withdraw','-5'],['vault','topup','7']]);});
test('ledger: owner Base Account signature fees are rows of their own (no balance), other owner transfers ignored',()=>{const OP='0x28Da22dcc90c4d9f4caeE6D0BFe11aEC413Ef609';
  const rows=classify([...X,{tx:'0x526f',block:4,t:4,li:0,from:O,to:OP,value:u(0.006111)},{tx:'0xaaaa',block:5,t:5,li:0,from:O,to:'0x0000000000000000000000000000000000000001',value:u(1)}],{wallet:W,vault:V,paymasters:[PM],owner:O,ownerPaymasters:[OP]});
  const f=rows.filter(r=>r.account==='owner');assert.deepEqual(f.map(r=>[r.tx,r.kind,r.delta,r.zh]),[['0x526f','ownerfee','-6111','确认手续费 · 你的 Base Account']]);
  const {rows:b}=withBalances(rows,{wallet:'14103220',vault:'191437'});assert.equal(b.find(r=>r.account==='owner').balance,null);assert.equal(b.find(r=>r.tx==='0x737e'&&r.account==='wallet').balance,'14103220');});
