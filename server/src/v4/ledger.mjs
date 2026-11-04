// Shared V4 ledger: one SQLite file shared by every agent process using the same wallet.
// Exactly-once is enforced three times: (1) purchase_key PRIMARY KEY claim under BEGIN IMMEDIATE,
// (2) operation_id UNIQUE, (3) on chain: adapter.opUsed[account][operationId] (survives a lost/forked ledger).
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {keccak256,toHex} from 'viem';
const sha=s=>createHash('sha256').update(s).digest('hex');
const canon=v=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x);

/** Purchase identity (M1, 2026-10-17). Same item => same key, whichever agent sees it and whatever intentId it uses.
 *  identity = (standard family, chain, payee, amount, merchant reference, repeatKey)
 *    merchant reference: signed order (signer+orderId) > merchantOrderId (direct / Stripe PI / Coinbase checkout) > MPP challenge id > x402 resource URL
 *    no merchant reference (e.g. a bare EIP-681 URI): the caller MUST give intentId or repeatKey, which then becomes the reference.
 *  intentId is NOT part of the key when the merchant supplies a reference (that was the V4 bug: two intents => two payments).
 *  repeatKey: an explicit "buy this same thing again" marker (e.g. a daily report: repeatKey='2026-10-18'). */
export function purchaseRef(n){
  if(n.signedOrder)return 'signed:'+String(n.signedOrder.signer).toLowerCase()+':'+String(n.signedOrder.orderId).toLowerCase();
  return n.merchantOrderId??n.challengeId??n.resource?.url??null;
}
export function purchaseKeyFor(n,opts={}){
  const o=typeof opts==='string'?{intentId:opts}:(opts??{}); // legacy callers passed intentId as a string
  let ref=purchaseRef(n);
  if(ref===null){const fb=o.repeatKey??o.intentId;if(!fb)throw Object.assign(Error('PURCHASE_REF_REQUIRED'),{code:'purchase_ref_required'});ref='caller:'+fb;}
  const fam=n.standard==='x402-v1'||String(n.standard).startsWith('x402')?'x402':n.standard;
  return sha(canon(['kipurse-purchase-v4.1',fam,n.chainId,n.payee.toLowerCase(),n.amount.toString(),ref,o.repeatKey??'']));
}
export const operationIdFor=key=>keccak256(toHex('agent-wallet-op-v4:'+key));

export class V4Ledger{
  constructor(file,{leaseMs=120000,store}={}){
    // busy timeout FIRST (and at open): `PRAGMA journal_mode=WAL` takes a lock, and with concurrent openers it used to fail
    // immediately with SQLITE_BUSY "database is locked" because busy_timeout was only set after it (flaky 20-thread race test).
    this.db=store?store.openDb(file,{timeout:10000}):new DatabaseSync(file,{timeout:10000});this.leaseMs=leaseMs;
    this.db.exec(`PRAGMA busy_timeout=10000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS intents(intent_id TEXT PRIMARY KEY, goal TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS purchases(purchase_key TEXT PRIMARY KEY, intent_id TEXT, standard TEXT NOT NULL, chain_id INTEGER NOT NULL, payee TEXT NOT NULL,
      amount TEXT NOT NULL, ref TEXT, operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('claimed','submitted','prepared','paid','failed','reclaimed')),
      claimed_by TEXT NOT NULL, lease_until INTEGER NOT NULL, tx_hash TEXT UNIQUE, settle_tx TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(idem_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, request_hash TEXT NOT NULL, purchase_key TEXT, response TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS claims(intent_id TEXT NOT NULL, line_key TEXT NOT NULL, agent_id TEXT NOT NULL, note TEXT, lease_until INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(intent_id,line_key));
    CREATE TABLE IF NOT EXISTS purchase_label(purchase_key TEXT PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS purchase_meta(purchase_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, merchant_id TEXT, tier TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, agent_id TEXT, purchase_key TEXT, name TEXT NOT NULL, detail TEXT);`);
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){try{this.db.exec('ROLLBACK');}catch{}throw e;}}
  event(agent,key,name,detail){this.db.prepare('INSERT INTO events(at,agent_id,purchase_key,name,detail) VALUES(?,?,?,?,?)').run(Date.now(),agent??null,key??null,name,detail===undefined?null:canon(detail));}
  addIntent(id,goal,by){this.db.prepare('INSERT OR IGNORE INTO intents VALUES(?,?,?,?)').run(id,goal,by,Date.now());}
  /** Returns {status:'new'|'replay'|'conflict', response?} */
  idempotencyBegin(key,agent,request){
    const h=sha(canon(request));
    return this.tx(()=>{const r=this.db.prepare('SELECT * FROM idempotency WHERE idem_key=?').get(key);
      if(!r){this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?)').run(key,agent,h,null,null,Date.now());return {status:'new'};}
      if(r.request_hash!==h||r.agent_id!==agent)return {status:'conflict'};
      return {status:'replay',response:r.response?JSON.parse(r.response):null};});
  }
  idempotencyEnd(key,purchaseKey,response){this.db.prepare('UPDATE idempotency SET purchase_key=?,response=? WHERE idem_key=?').run(purchaseKey??null,canon(response),key);}
  /** Atomic claim. Returns {won:true, row} for exactly one caller per purchase key (until it finishes or its pre-submit lease expires). */
  claim(key,n,intentId,agent){
    const now=Date.now(),op=operationIdFor(key);
    return this.tx(()=>{
      const r=this.db.prepare('SELECT * FROM purchases WHERE purchase_key=?').get(key);
      if(!r){this.db.prepare(`INSERT INTO purchases VALUES(?,?,?,?,?,?,?,?,'claimed',?,?,NULL,NULL,NULL,?,?)`).run(key,intentId??null,n.standard,n.chainId,n.payee,n.amount.toString(),n.merchantOrderId??n.resource?.url??null,op,agent,now+this.leaseMs,now,now);
        this.event(agent,key,'claimed');return {won:true,row:this.get(key)};}
      // take over only if the previous claimer never submitted anything and its lease expired, or it definitively failed before submit
      if((r.state==='claimed'&&r.lease_until<now)||(r.state==='failed'&&!r.tx_hash)){
        this.db.prepare(`UPDATE purchases SET state='claimed',claimed_by=?,lease_until=?,updated_at=? WHERE purchase_key=?`).run(agent,now+this.leaseMs,now,key);
        this.event(agent,key,'claim_takeover',{from:r.claimed_by,prevState:r.state});return {won:true,row:this.get(key)};}
      this.event(agent,key,'claim_lost',{owner:r.claimed_by,state:r.state});return {won:false,row:r};
    });
  }
  update(key,agent,fields){
    const cols=Object.keys(fields);const now=Date.now();
    this.tx(()=>{const r=this.get(key);if(!r||r.claimed_by!==agent)throw Error('LEDGER_NOT_CLAIM_OWNER');
      this.db.prepare(`UPDATE purchases SET ${cols.map(c=>c+'=?').join(',')},updated_at=? WHERE purchase_key=?`).run(...cols.map(c=>typeof fields[c]==='object'&&fields[c]!==null?canon(fields[c]):fields[c]),now,key);
      this.event(agent,key,'update',fields.state?{state:fields.state,tx:fields.tx_hash??fields.settle_tx}:undefined);});
  }
  /** Team coordination: first agent to claim (intentId,lineKey) owns it until ttl expires. Returns {won, owner, leaseUntil}. */
  claimLine(intentId,lineKey,agent,{ttlMs=600000,note}={}){
    const now=Date.now();
    return this.tx(()=>{const r=this.db.prepare('SELECT * FROM claims WHERE intent_id=? AND line_key=?').get(intentId,lineKey);
      if(!r){this.db.prepare('INSERT INTO claims VALUES(?,?,?,?,?,?)').run(intentId,lineKey,agent,note??null,now+ttlMs,now);this.event(agent,null,'line_claimed',{intentId,lineKey});return {won:true,owner:agent,leaseUntil:now+ttlMs};}
      if(r.agent_id===agent||r.lease_until<now){this.db.prepare('UPDATE claims SET agent_id=?,lease_until=?,note=? WHERE intent_id=? AND line_key=?').run(agent,now+ttlMs,note??r.note,intentId,lineKey);return {won:true,owner:agent,leaseUntil:now+ttlMs,renewed:r.agent_id===agent,tookOverFrom:r.agent_id===agent?undefined:r.agent_id};}
      return {won:false,owner:r.agent_id,leaseUntil:r.lease_until};});
  }
  /** display-only shop name the agent gave (never used for trust/limits) */
  setLabel(key,label){if(!label)return;this.db.prepare('INSERT OR IGNORE INTO purchase_label VALUES(?,?)').run(key,String(label).slice(0,80));}
  setMeta(key,agent,{merchantId,tier}={}){this.db.prepare('INSERT OR IGNORE INTO purchase_meta VALUES(?,?,?,?,?)').run(key,agent,merchantId??null,tier??null,Date.now());}
  /** Sum (atomic, BigInt) committed by one agent since a timestamp: claimed/submitted/prepared/paid rows it originated. */
  agentSpentSince(agent,sinceMs){let t=0n;for(const r of this.db.prepare(`SELECT p.amount FROM purchases p JOIN purchase_meta m ON m.purchase_key=p.purchase_key WHERE m.agent_id=? AND p.state IN ('claimed','submitted','prepared','paid') AND p.created_at>=?`).all(agent,sinceMs))t+=BigInt(r.amount);return t;}
  history({payee,merchantId}={}){const rows=this.db.prepare(`SELECT p.state,p.amount,p.payee,m.merchant_id FROM purchases p LEFT JOIN purchase_meta m ON m.purchase_key=p.purchase_key`).all()
      .filter(r=>(payee&&r.payee.toLowerCase()===payee.toLowerCase())||(merchantId&&r.merchant_id===merchantId));
    let paid=0,paidAtomic=0n,failed=0;for(const r of rows){if(r.state==='paid'){paid++;paidAtomic+=BigInt(r.amount);}if(r.state==='failed')failed++;}return {purchases:rows.length,paid,paidAtomic:paidAtomic.toString(),failed};}
  listFiltered({since=0,agentId,state,limit=50}={}){return this.db.prepare(`SELECT p.*,m.agent_id AS origin_agent,m.merchant_id,m.tier,lb.label FROM purchases p LEFT JOIN purchase_meta m ON m.purchase_key=p.purchase_key LEFT JOIN purchase_label lb ON lb.purchase_key=p.purchase_key WHERE p.created_at>=? ORDER BY p.created_at DESC`).all(since)
      .filter(r=>(!agentId||r.origin_agent===agentId||r.claimed_by===agentId)&&(!state||r.state===state)).slice(0,Math.min(limit,500));}
  get(key){return this.db.prepare('SELECT * FROM purchases WHERE purchase_key=?').get(key);}
  list(){return this.db.prepare('SELECT * FROM purchases ORDER BY created_at').all();}
  events(key){return this.db.prepare('SELECT * FROM events WHERE purchase_key=? ORDER BY id').all(key);}
  close(){this.db.close();}
}
