// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse V5 records for the owner (M6, 2026-10-17): tax/accounting CSV, per-payment receipts, annual summary.
// Read-only over the local ledger. Amounts are USDC (6 decimals, treated 1:1 as USD; the CSV says so). Times are shown in the
// owner's time zone (default America/Chicago) plus UTC. Payer view: amount = paid to the merchant; protocol_fee = Kipurse 0.1%
// (rounded up); network_fee = gas reimbursed in USDC; gas_recovery = earlier failed-tx gas recovered with this payment.
// Float micropayments: vouchers carry fee 0; the session's actual 0.1% fee (on the day total, rounded up) is on the reconcile row.
const U=v=>(v===null||v===undefined||v==='')?'0.000000':(Number(BigInt(v))/1e6).toFixed(6);
const big=v=>{try{return BigInt(v??0);}catch{return 0n;}};
const EXPLORER={8453:'https://basescan.org/tx/',84532:'https://sepolia.basescan.org/tx/'};
export const CSV_COLUMNS=['date_local','date_utc','time_zone','type','merchant','payee','purchase_key','agent','intent','amount_usdc','protocol_fee_usdc','network_fee_usdc','gas_recovery_usdc','total_cost_usdc','refund_usdc','tx_hash','settlement_tx','chain_id','token','note'];
const fmt=(ms,tz)=>new Intl.DateTimeFormat('sv-SE',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(ms)).replace('T',' ');
/** CSV cell: quote always; neutralise spreadsheet formulas (=,+,-,@,tab,CR at the start) from merchant-supplied text. */
export const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s)&&!/^-?\d+(\.\d+)?$/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};

export function records(db,{chainId,token}={}){
  const meta=Object.fromEntries(db.prepare('SELECT * FROM purchase_meta').all().map(m=>[m.purchase_key,m]));
  const out=[];
  for(const r of db.prepare(`SELECT * FROM purchases WHERE state IN ('paid','reclaimed','prepared') ORDER BY updated_at`).all()){
    let res={};try{res=JSON.parse(r.result??'{}');}catch{}const inner=res.result??{};const m=meta[r.purchase_key]??{};
    const fl=!!(res.float||inner.float);
    if(r.state==='prepared'&&!fl&&!res.prepareTx)continue;
    const nf=big(res.networkFee??inner.networkFee),gr=big(res.gasRecovery??inner.gasRecovery),fe=fl?0n:big(res.fee??inner.fee),amt=big(r.amount);
    const type=fl?'float_voucher':r.standard?.startsWith('x402')?'x402':r.standard==='signed-order'?'signed_order':(r.standard??'payment');
    if(r.state==='reclaimed'){out.push({at:r.updated_at,type:'refund',merchant:m.merchant_id,payee:r.payee,key:r.purchase_key,agent:r.claimed_by,intent:r.intent_id,amount:0n,fee:0n,nf,gr,refund:amt+fe,
      tx:res.prepareTx??r.tx_hash,settle:String(r.settle_tx??'').replace(/^reclaim /,''),note:'authorization never settled: amount + protocol fee refunded; network fee kept (gas was spent)'});continue;}
    if(r.state==='prepared'&&fl)continue; // voucher not (yet) accepted by the merchant
    if(r.state==='prepared')continue;     // x402 prepared, not settled yet
    out.push({at:r.updated_at,type,merchant:m.merchant_id,payee:r.payee,key:r.purchase_key,agent:r.claimed_by,intent:r.intent_id,amount:amt,fee:fe,nf,gr,refund:0n,
      tx:res.txHash??res.prepareTx??inner.prepareTx??r.tx_hash,settle:r.settle_tx,note:fl?'paid from the daily float; fee on the reconcile row':(res.note??'')});
  }
  let fs=[];try{fs=db.prepare('SELECT * FROM float_sessions ORDER BY funded_at').all();}catch{}
  for(const f of fs){
    out.push({at:f.funded_at,type:'float_fund',merchant:'',payee:f.float_vault,key:f.session,agent:'',intent:'',amount:0n,fee:0n,nf:big(f.network_fee),gr:0n,refund:0n,tx:f.fund_tx,settle:'',
      note:`moved ${U(f.funded)} USDC into your own float (not an expense); network fee covers funding + reconcile gas`});
    if(f.reconcile_tx)out.push({at:f.reconciled_at,type:'float_reconcile',merchant:'',payee:f.float_vault,key:f.session,agent:'',intent:'',amount:0n,fee:big(f.fee),nf:0n,gr:0n,refund:0n,tx:f.reconcile_tx,settle:'',
      note:`float spent ${U(f.spent)} USDC; 0.1% fee on the total, rounded up; unspent float returned`});
  }
  for(const o of out){o.chainId=chainId;o.token=token;o.total=o.amount+o.fee+o.nf+o.gr;}
  return out.sort((a,b)=>a.at-b.at);
}
export function toCsv(db,{from,to,tz='America/Chicago',chainId,token}={}){
  const f=from?Date.parse(from):-Infinity,t=to?Date.parse(to):Infinity;
  const rows=records(db,{chainId,token}).filter(r=>r.at>=f&&r.at<t);
  const lines=[CSV_COLUMNS.join(',')];
  for(const r of rows)lines.push([fmt(r.at,tz),new Date(r.at).toISOString(),tz,r.type,r.merchant??'',r.payee??'',r.key,r.agent??'',r.intent??'',U(r.amount),U(r.fee),U(r.nf),U(r.gr),U(r.total),U(r.refund),r.tx??'',r.settle??'',r.chainId??'',r.token??'',r.note??''].map(cell).join(','));
  const sum=k=>rows.reduce((a,r)=>a+r[k],0n);
  return {csv:lines.join('\r\n')+'\r\n',rows:rows.length,totals:{amount:U(sum('amount')),protocolFee:U(sum('fee')),networkFee:U(sum('nf')),gasRecovery:U(sum('gr')),totalCost:U(sum('total')),refunds:U(sum('refund'))},
    note:'USDC treated 1:1 as USD. Not tax advice.'};
}
export function receipt(db,key,{tz='America/Chicago',chainId,token,payer}={}){
  const r=records(db,{chainId,token}).find(x=>x.key===key&&x.type!=='float_fund');if(!r)return {state:'not_found',purchaseKey:key};
  const link=h=>h&&EXPLORER[chainId]?EXPLORER[chainId]+h:null;
  const no='KP-'+new Date(r.at).toISOString().slice(0,10).replace(/-/g,'')+'-'+key.replace(/^0x/,'').slice(0,8).toUpperCase();
  const o={state:'ok',receiptNo:no,purchaseKey:key,type:r.type,date:fmt(r.at,tz)+' '+tz,dateUtc:new Date(r.at).toISOString(),payer:payer??null,merchant:r.merchant??null,payee:r.payee,
    amount:U(r.amount),protocolFee:U(r.fee),networkFee:U(r.nf),gasRecovery:U(r.gr),total:U(r.total),refund:U(r.refund),currency:'USDC',txHash:r.tx??null,txUrl:link(r.tx),settlementTx:r.settle||null,settlementUrl:link(r.settle),note:r.note};
  o.text=[`Kipurse receipt ${no}`,`Date: ${o.date}`,`Merchant: ${o.merchant??'(unregistered)'} (${o.payee})`,`Paid to merchant: ${o.amount} USDC`,`Kipurse fee (0.1%): ${o.protocolFee} USDC`,
    `Network fee (gas): ${o.networkFee} USDC`+(r.gr?` + recovered earlier failed-tx gas ${o.gasRecovery} USDC`:''),`Total paid by you: ${o.total} USDC`+(r.refund?` (refunded ${o.refund} USDC)`:''),
    `Transaction: ${o.txUrl??o.txHash??'-'}`,o.settlementUrl?`Settlement: ${o.settlementUrl}`:null,o.note?`Note: ${o.note}`:null].filter(Boolean).join('\n');
  return o;
}
export function annualSummary(db,year,{tz='America/Chicago',chainId,token}={}){
  const y=String(year);const rows=records(db,{chainId,token}).filter(r=>fmt(r.at,tz).startsWith(y));
  const add=(m,k,r)=>{const x=m[k]??={count:0,amount:0n,protocolFee:0n,networkFee:0n,total:0n,refunds:0n};if(r.amount>0n||r.type==='refund')x.count++;x.amount+=r.amount;x.protocolFee+=r.fee;x.networkFee+=r.nf+r.gr;x.total+=r.total;x.refunds+=r.refund;};
  const byMerchant={},byMonth={},byType={},all={};
  for(const r of rows){add(all,'all',r);add(byMerchant,r.merchant||(r.type.startsWith('float_')?'(float)':r.payee),r);add(byMonth,fmt(r.at,tz).slice(0,7),r);add(byType,r.type,r);}
  const out=m=>Object.fromEntries(Object.entries(m).map(([k,v])=>[k,{count:v.count,amount:U(v.amount),protocolFee:U(v.protocolFee),networkFee:U(v.networkFee),total:U(v.total),refunds:U(v.refunds)}]));
  return {year:Number(y),timeZone:tz,currency:'USDC',totals:out(all).all??{count:0,amount:'0.000000',protocolFee:'0.000000',networkFee:'0.000000',total:'0.000000',refunds:'0.000000'},
    byMonth:out(byMonth),byMerchant:out(byMerchant),byType:out(byType),note:'USDC treated 1:1 as USD. Not tax advice. Export the CSV for line items.'};
}
