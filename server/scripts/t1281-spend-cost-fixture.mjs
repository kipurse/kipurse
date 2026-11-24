// SPDX-License-Identifier: AGPL-3.0-only
// t1281 (handbook §6#141, rule 0A#10): cross-test vectors for the ONE spend-cost formula (src/v5/spend-cost.mjs), read by the app's
// KipurseCore SpendCost test. Each case: the record as the app sees it (amount, fee, networkFee or null, state, ppm, maxNetworkFee) and
// the server's costOf() of the same record. Regenerate:
//   node scripts/t1281-spend-cost-fixture.mjs > ~/kipurse-ios/Kipurse/Tests/KipurseCoreTests/t1281-spend-cost.json.txt
// test/t1281-fee-counting.test.mjs fails when the file is stale.
import {costOf,costParts} from '../src/v5/spend-cost.mjs';
const rows=[
  // finished payments with the server's own fee / network fee (paid direct / signed, prepared x402)
  {amount:'500000',result:{fee:'500',networkFee:'3500'},state:'paid'},
  {amount:'1000000',result:{fee:'1000',networkFee:'7123'},state:'paid'},
  {amount:'999999',result:{fee:'1000',networkFee:'0'},state:'prepared'},
  {amount:'250000000',result:{fee:'250000',networkFee:'48000'},state:'paid'},
  // float voucher (no tx of ours): network fee 0
  {amount:'90000',result:{float:true,fee:'90',networkFee:'0'},state:'paid'},
  // reconciled after a lost send: network fee from the pending quote / missing
  {amount:'2000000',result:{note:'confirmed by reconcile',networkFee:'4200'},state:'paid'},
  {amount:'2000000',result:{note:'purchase already used on chain'},state:'paid'},
  {amount:'2000000',result:null,state:'paid'},
  // in flight: submitted with its quote; claimed / submitted without one -> the owner's maxNetworkFee
  {amount:'300000',result:{pending:{networkFee:'3900'}},state:'submitted'},
  {amount:'300000',result:null,state:'claimed'},
  {amount:'300000',result:{pending:{}},state:'submitted'},
  // rounding of the protocol fee (ceil, like the adapter)
  {amount:'1',result:null,state:'paid'},{amount:'999',result:null,state:'paid'},{amount:'1000',result:null,state:'paid'},{amount:'1001',result:null,state:'paid'},
  {amount:'0',result:null,state:'paid'},{amount:'123456789',result:null,state:'paid'},{amount:'9000000000000',result:null,state:'paid'},
];
const params=[{ppm:1000n,maxNetworkFee:50000n},{ppm:0n,maxNetworkFee:50000n},{ppm:3000n,maxNetworkFee:20000n},{ppm:1n,maxNetworkFee:0n}];
const cases=[];
for(const pr of params)for(const r of rows){const res=r.result??{};const parts=costParts(r,pr);
  cases.push({amount:r.amount,fee:res.fee??null,networkFee:res.networkFee??res.pending?.networkFee??null,state:r.state,ppm:Number(pr.ppm),maxNetworkFee:pr.maxNetworkFee.toString(),
    expectedFee:parts.fee.toString(),expectedNetworkFee:parts.networkFee.toString(),expected:costOf(r,pr).toString()});}
process.stdout.write(JSON.stringify({about:'t1281 spend cost = amount + protocol fee + network fee (gw src/v5/spend-cost.mjs)',cases},null,1)+'\n');
