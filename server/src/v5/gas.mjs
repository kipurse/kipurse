// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse V5 gas accounting (M2, 2026-10-17). Owner principle #1: users bear ALL gas; we never subsidize.
//  - every payment reimburses its own quoted gas (+ margin) in USDC in the same tx, <= the owner-signed Policy.maxNetworkFee;
//  - a tx that still reverts on chain (after a passing simulation) spent real gas: that cost is recorded here as debt and
//    recovered on the next successful payment of the same wallet, within the same owner cap (any remainder carries over);
//  - 3 on-chain failures per agent per day stop that agent until the next UTC day (or an owner/operator reset);
//  - one in-flight payment tx per account (the next one is told to retry later, never queued blindly).
// ETH/USD for the quote: fixed config on testnet; on mainnet a Chainlink ETH/USD feed with staleness + sanity bounds
// (refuse to quote rather than guess). Pure code: no scheduler, no network calls except the feed read.
import {parseAbi} from 'viem';

export const MAX_FAILURES_PER_AGENT_PER_DAY=3;
const day=(ms=Date.now())=>new Date(ms).toISOString().slice(0,10);
const ceilDiv=(a,b)=>(a+b-1n)/b;
export const weiToUsdc=(wei,usdcPerEth)=>ceilDiv(BigInt(wei)*BigInt(usdcPerEth),10n**18n);

export class GasBook{
  constructor(db){this.db=db;db.exec(`
    CREATE TABLE IF NOT EXISTS gas_debt(id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, agent_id TEXT, tx_hash TEXT, reason TEXT,
      gas_used TEXT, gas_price TEXT, amount INTEGER NOT NULL, recovered INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gas_recovery(id INTEGER PRIMARY KEY AUTOINCREMENT, debt_id INTEGER NOT NULL, amount INTEGER NOT NULL, tx_hash TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tx_failures(agent_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, last_tx TEXT, PRIMARY KEY(agent_id,day));
    CREATE TABLE IF NOT EXISTS op_charges(id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, user_op_hash TEXT, tx_hash TEXT, success INTEGER,
      charged INTEGER NOT NULL, topped INTEGER NOT NULL DEFAULT 0, topped_tx TEXT, at INTEGER NOT NULL);`);
    // kind: 'pay' = a payment's own userOp; 'owner' = owner/maintenance actions (trust relays, settle, pause...). Owner-action gas is paid
    // from the owner's own vault buffer and is NOT billed to the next agent payment unless the buffer runs low (then shown as its own line).
    if(!this.db.prepare(`SELECT 1 FROM pragma_table_info('op_charges') WHERE name='kind'`).get())this.db.exec(`ALTER TABLE op_charges ADD COLUMN kind TEXT NOT NULL DEFAULT 'pay'`);}
  /** ZERO-RESERVE: the actual USDC the paymaster took from the owner's vault for one userOp (success or not). */
  recordCharge({account,userOpHash,txHash,charged,success=true,kind='pay',now=Date.now()}){if(BigInt(charged)<=0n)return;
    this.db.prepare(`INSERT INTO op_charges(account,user_op_hash,tx_hash,success,charged,at,kind) VALUES(?,?,?,?,?,?,?)`).run(account.toLowerCase(),userOpHash??null,txHash??null,success?1:0,Number(charged),now,kind==='owner'?'owner':'pay');}
  /** Charges not yet topped up: the next op pulls exactly this (capped by maxGasPerOp) from the owner's permission into the vault. */
  pendingTopUp(account,kind){return BigInt(this.db.prepare(`SELECT COALESCE(SUM(charged-topped),0) AS o FROM op_charges WHERE account=? AND topped<charged${kind?' AND kind=?':''}`).get(...[account.toLowerCase(),...(kind?[kind]:[])]).o);}
  markToppedUp(account,amount,txHash){let left=BigInt(amount);for(const r of this.db.prepare(`SELECT id,charged,topped FROM op_charges WHERE account=? AND topped<charged ORDER BY CASE kind WHEN 'pay' THEN 0 ELSE 1 END,id`).all(account.toLowerCase())){
    if(left===0n)break;const open=BigInt(r.charged)-BigInt(r.topped);const take=open<left?open:left;this.db.prepare(`UPDATE op_charges SET topped=topped+?,topped_tx=? WHERE id=?`).run(Number(take),txHash??null,r.id);left-=take;}
    return BigInt(amount)-left;}
  charges(account){return this.db.prepare(`SELECT * FROM op_charges WHERE account=? ORDER BY id`).all(account.toLowerCase());}
  /** A tx that reverted on chain: record its real gas cost (USDC atomic, rounded up) as debt and count the agent failure. */
  recordFailure({account,agentId,txHash,gasUsed,gasPrice,usdcPerEth,reason='reverted_on_chain',now=Date.now()}){
    const amount=gasUsed&&gasPrice&&usdcPerEth?weiToUsdc(BigInt(gasUsed)*BigInt(gasPrice),usdcPerEth):0n;
    if(amount>0n)this.db.prepare(`INSERT INTO gas_debt(account,agent_id,tx_hash,reason,gas_used,gas_price,amount,at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(account.toLowerCase(),agentId??null,txHash??null,reason,String(gasUsed??''),String(gasPrice??''),Number(amount),now);
    this.db.prepare(`INSERT INTO tx_failures(agent_id,day,count,last_tx) VALUES(?,?,1,?) ON CONFLICT(agent_id,day) DO UPDATE SET count=count+1,last_tx=excluded.last_tx`)
      .run(String(agentId??'agent'),day(now),txHash??null);
    return {debt:amount,failuresToday:this.failuresToday(agentId,now)};
  }
  outstanding(account){const r=this.db.prepare(`SELECT COALESCE(SUM(amount-recovered),0) AS o FROM gas_debt WHERE account=? AND recovered<amount`).get(account.toLowerCase());return BigInt(r.o);}
  /** How much of the outstanding debt fits next to this payment's own gas quote under the owner cap. */
  recoverable(account,quote,cap){const room=BigInt(cap)>BigInt(quote)?BigInt(cap)-BigInt(quote):0n;const o=this.outstanding(account);return o<room?o:room;}
  /** After a successful payment that carried `amount` of recovery: settle debts oldest first. */
  applyRecovery(account,amount,txHash,now=Date.now()){
    let left=BigInt(amount);if(left<=0n)return 0n;
    const rows=this.db.prepare(`SELECT id,amount,recovered FROM gas_debt WHERE account=? AND recovered<amount ORDER BY id`).all(account.toLowerCase());
    for(const r of rows){if(left===0n)break;const open=BigInt(r.amount)-BigInt(r.recovered);const take=open<left?open:left;
      this.db.prepare(`UPDATE gas_debt SET recovered=recovered+? WHERE id=?`).run(Number(take),r.id);
      this.db.prepare(`INSERT INTO gas_recovery(debt_id,amount,tx_hash,at) VALUES(?,?,?,?)`).run(r.id,Number(take),txHash??null,now);left-=take;}
    return BigInt(amount)-left;
  }
  failuresToday(agentId,now=Date.now()){const r=this.db.prepare(`SELECT count FROM tx_failures WHERE agent_id=? AND day=?`).get(String(agentId??'agent'),day(now));return r?Number(r.count):0;}
  stopped(agentId,now=Date.now()){return this.failuresToday(agentId,now)>=MAX_FAILURES_PER_AGENT_PER_DAY;}
  /** Owner / operator only (CLI), never an agent tool. */
  resetFailures(agentId,now=Date.now()){this.db.prepare(`DELETE FROM tx_failures WHERE agent_id=? AND day=?`).run(String(agentId),day(now));}
  debts(account){return this.db.prepare(`SELECT * FROM gas_debt WHERE account=? ORDER BY id`).all(account.toLowerCase());}
}

/** One in-flight payment tx per account. try() returns a release fn, or null when a tx is already in flight. */
export function inflightLock(){const busy=new Set();return {try(account){const k=account.toLowerCase();if(busy.has(k))return null;busy.add(k);return ()=>busy.delete(k);},busy:a=>busy.has(a.toLowerCase())};}

const AGG=parseAbi(['function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)','function decimals() view returns (uint8)']);
/** Chainlink ETH/USD feeds (AggregatorV3). Verify on chain (description() == "ETH / USD") before relying on one. */
export const ETH_USD_FEEDS={8453:'0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31',84532:'0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1'};
/** usdcPerEth (atomic USDC per 1 ETH) from a live feed. Refuses (throws network_fee_unquotable) when the answer is stale,
 *  non-positive, from an incomplete round, or outside the sanity band; a wrong price must never under-recover gas silently. */
export async function liveUsdcPerEth(pub,{address,maxAgeSec=3600,minUsd=100,maxUsd=100000,nowS}={}){
  const fail=d=>{throw Object.assign(Error('NETWORK_FEE_UNQUOTABLE: '+d),{code:'network_fee_unquotable',detail:d});};
  let rd,dec;try{[rd,dec]=await Promise.all([pub.readContract({address,abi:AGG,functionName:'latestRoundData'}),pub.readContract({address,abi:AGG,functionName:'decimals'})]);}catch(e){fail('eth_usd_feed_unreadable');}
  const [roundId,answer,,updatedAt,answeredInRound]=rd;const now=BigInt(nowS??Math.floor(Date.now()/1000));
  if(answer<=0n)fail('eth_usd_non_positive');if(answeredInRound<roundId)fail('eth_usd_incomplete_round');
  if(now-updatedAt>BigInt(maxAgeSec))fail('eth_usd_stale');
  const usdcPerEth=BigInt(answer)*10n**6n/10n**BigInt(dec); // USD has 'dec' decimals; USDC has 6
  if(usdcPerEth<BigInt(minUsd)*10n**6n||usdcPerEth>BigInt(maxUsd)*10n**6n)fail('eth_usd_out_of_band');
  return usdcPerEth;
}

// ---- Pre-audit (2026-10-17): L2 sequencer uptime + second, independent ETH/USD source ----
/** Chainlink L2 Sequencer Uptime Feed. Base mainnet verified on chain (description "L2 Sequencer Uptime Status Feed").
 *  Chainlink publishes no Base Sepolia sequencer feed; on Sepolia the check reports 'unavailable' unless an address is configured. */
export const SEQUENCER_FEEDS={8453:'0xc0de905ea16e84e3c5f50f1144f8f3bbacc7a356'};
const SEQ=[{type:'function',name:'latestRoundData',stateMutability:'view',inputs:[],outputs:[{type:'uint80'},{type:'int256'},{type:'uint256'},{type:'uint256'},{type:'uint80'}]}];
const unquotable=d=>Object.assign(Error('NETWORK_FEE_UNQUOTABLE: '+d),{code:'network_fee_unquotable',detail:d});
/** answer 0 = up, 1 = down; startedAt = when the current status began. Refuse while down and for graceSec after it comes back. */
export async function sequencerCheck(pub,{address,graceSec=3600,nowS}){
  let r;try{r=await pub.readContract({address,abi:SEQ,functionName:'latestRoundData'});}catch{throw unquotable('sequencer_feed_unreadable');}
  const answer=BigInt(r[1]),startedAt=BigInt(r[2]);const now=BigInt(nowS??Math.floor(Date.now()/1000));
  if(answer!==0n)throw unquotable('sequencer_down');
  if(startedAt===0n||now-startedAt<BigInt(graceSec))throw unquotable('sequencer_grace_period');
  return {up:true,since:Number(startedAt)};
}
/** Independent second ETH/USD sources (off-chain exchange tickers; the gateway is off-chain). Returns atomic USDC per ETH. */
export const SECOND_SOURCES={
  'coinbase-exchange':{url:'https://api.exchange.coinbase.com/products/ETH-USD/ticker',parse:j=>({usd:j.price,at:j.time?Date.parse(j.time)/1000:undefined})},
  kraken:{url:'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',parse:j=>{if(j.error?.length)throw Error('kraken');const k=Object.keys(j.result??{})[0];return {usd:j.result[k].c[0]};}},
};
const toAtomic=usd=>{const [i,f='']=String(usd).trim().split('.');if(!/^\d+$/.test(i)||!/^\d*$/.test(f))throw Error('bad price');return BigInt(i)*10n**6n+BigInt((f+'000000').slice(0,6));};
export async function secondUsdcPerEth({source='coinbase-exchange',fetchImpl=globalThis.fetch,timeoutMs=3000,maxAgeSec=300,minUsd=100,maxUsd=100000,nowS}={}){
  const s=typeof source==='string'?SECOND_SOURCES[source]:source;if(!s)throw unquotable('second_price_unknown_source');
  let v;try{const ac=new AbortController();const t=setTimeout(()=>ac.abort(),timeoutMs);
    try{const r=await fetchImpl(s.url,{signal:ac.signal,headers:{accept:'application/json'}});if(!r.ok)throw Error('http '+r.status);v=s.parse(await r.json());}finally{clearTimeout(t);}}
  catch{throw unquotable('second_price_unavailable');}
  let a;try{a=toAtomic(v.usd);}catch{throw unquotable('second_price_unavailable');}
  if(v.at!==undefined&&Math.floor(nowS??Date.now()/1000)-v.at>maxAgeSec)throw unquotable('second_price_stale');
  if(a<BigInt(minUsd)*10n**6n||a>BigInt(maxUsd)*10n**6n)throw unquotable('second_price_out_of_band');
  return a;
}
/** Divergence in basis points of the lower price. */
export const divergenceBps=(a,b)=>{const lo=a<b?a:b,hi=a<b?b:a;return Number((hi-lo)*10000n/lo);};
