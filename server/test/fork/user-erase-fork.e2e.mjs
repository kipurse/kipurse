// FORK-ONLY end-to-end for "delete my data" on the mainnet wiring (mainnetEraseParts + createUserDataEraser over HTTP).
// Isolated: its own anvil fork, a temp data dir, synthetic off-chain records. Nothing is sent to a real network.
//   FORK_RPC=http://127.0.0.1:18591 FORK_PERMISSION_JSON='{...}' node --test test/fork/user-erase-fork.e2e.mjs
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeFunctionData,keccak256,toHex} from 'viem';import {base} from 'viem/chains';
import * as P256 from 'ox/P256';
import {createPhoneEnrollment,WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {createPhoneSession,sessionDigest} from '../../src/v5/phone-session.mjs';
import {createOwnerPay} from '../../src/v5/owner-pay.mjs';import {createEngineV5} from '../../src/v5/engine.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';
import {createUserDataEraser,mainnetEraseParts,eraseDigest} from '../../src/v5/user-data.mjs';import {createLedger} from '../../src/v5/ledger.mjs';import {createPublicLimits} from '../../src/v5/limits-public.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);const AD=parseAbi(['function trust() view returns (address)']);
const EXEC_ABI=parseAbi(['function execute(address target,uint256 value,bytes data) payable']);
test('delete my data: authenticated, complete, idempotent; owner can still withdraw',{skip:!RPC||!PJ,timeout:300000},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  assert.equal(await pub.getChainId(),8453);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  for(const a of [EXEC,OWNER]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  {// FIXTURE FIX: the fixture wallet is empty on mainnet now (owner withdrew everything) -> top it up on the FORK from a USDC whale
    const WH='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:WH});await tc.setBalance({address:WH,value:10n**18n});
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:WH}).writeContract({address:USDC,abi:parseAbi(['function transfer(address,uint256) returns (bool)']),functionName:'transfer',args:[W,50_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
  const run=async(calls,from)=>{for(const c of calls){const h=await createWalletClient({chain:base,transport:vh(RPC),account:from}).sendTransaction({to:c.to,data:c.data,value:0n});assert.equal((await pub.waitForTransactionReceipt({hash:h})).status,'success');}};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  // synthetic tenant state (same shape as runtime-state.json)
  const dir=mkdtempSync(join(tmpdir(),'erase-'));const SF=join(dir,'runtime-state.json');
  const S={permission:perm,capChangedAt:'2026-10-01T00:00:00Z',agentLastSeen:{muse:'2026-10-23T00:00:00Z','grok-bot':'2026-10-23T00:00:00Z'},
    oauth:{clients:{c1:{name:'Synthetic Claude',redirect:'https://x.invalid/cb'}},pending:{p1:{client:'c1',exp:9e9}},codes:{k1:{agentId:'oauth-claude'}},tokens:{t1:{agentId:'oauth-claude',exp:9e9}}},
    oauthAgents:{'oauth-claude':{id:'oauth-claude',name:'Synthetic Claude',kind:'claude-desktop'}},ownerPay:{[W.toLowerCase()]:{payments:[{txHash:'0x01',payee:'0x02',amount:'10000'}]},'0x000000000000000000000000000000000000beef':{payments:[{txHash:'0x03'}]}}};
  const save=()=>fs.writeFileSync(SF,JSON.stringify(S));
  // phone V2 enrolled on the fork (stand-in for the Secure Enclave key)
  const k=kp(),attacker=kp();
  const PH=createPhoneEnrollment({S,save,pub,wallet:W,trust,owner:OWNER,chainId:8453,base:()=>'http://fork.invalid',caps:()=>({single:1000000n,daily:2000000n}),script:()=>'',approverVersion:'v2'});
  const e=await PH.enroll(k);await run(PH.calls(S.phone.pending[e.id]),OWNER);assert.equal((await PH.confirm(e.id)).ok,true);
  // trust requests file + engine ledger with synthetic rows
  const TRF=join(dir,'tr.json');fs.writeFileSync(TRF,JSON.stringify({seq:7,requests:{r1:{id:'r1',status:'awaiting_owner',payee:'0x4f2a9C1e0B7d3E8a6F5c2D1b0A9e8F7c6D5b4A3e',chain:'base',chainId:8453,merchantName:'Synthetic Shop',single:'1000000',total:'2000000',reason:'buy a VPS',agentId:'muse',requestedBy:['muse'],createdAt:1,updatedAt:1,pendingUntil:9e9}}}));
  const cfg={chainId:8453,rpc:RPC,adapter:A,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',token:USDC,policy:pol,permission:perm,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,
    gasPricing:{usdcPerEth:'3000000000',gasPriceWei:'10000000'},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,ownerRulesDir:join(dir,'rules'),trustRequestsFile:TRF};
  const engine=createEngineV5(cfg,{ledgerFile:join(dir,'l.sqlite'),agentDefault:'owner'});const db=engine.ledger.db;const O=()=>cfg.__trustRequestsOwner;
  assert.equal(O().api.list(O().cap).pending.length,1,'seeded trust request visible');
  const now=Date.now();
  db.exec(`INSERT INTO intents VALUES('i1','buy a VPS for my side project','muse',${now})`);
  db.prepare(`INSERT INTO purchases(purchase_key,intent_id,standard,chain_id,payee,amount,ref,operation_id,state,claimed_by,lease_until,tx_hash,settle_tx,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('pk1','i1','x402',8453,'0x4f2a9C1e0B7d3E8a6F5c2D1b0A9e8F7c6D5b4A3e','250000','ref1','op1','paid','muse',0,'0xaa',null,JSON.stringify({txHash:'0xaa',fee:'250',networkFee:'8563',digest:'0xdd',merchantResponse:{order:'synthetic order #42',email:'student@example.invalid'}}),now,now);
  db.exec(`INSERT INTO purchase_label VALUES('pk1','Synthetic Shop');INSERT INTO purchase_meta VALUES('pk1','muse','shop.example',NULL,${now});INSERT INTO events(at,agent_id,purchase_key,name,detail) VALUES(${now},'muse','pk1','paid','private note');
    INSERT INTO idempotency VALUES('idem1','muse','h','pk1','{}',${now});INSERT INTO claims VALUES('i1','l1','muse','note',0,${now});INSERT INTO gas_recovery(debt_id,amount,tx_hash,at) VALUES(1,7105,'0xgg',${now});`);
  const gasBefore=['gas_debt','gas_recovery','op_charges','float_vouchers','float_sessions'].map(t=>{try{return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;}catch{return -1;}});
  const LEDF=join(dir,'ledger.json');fs.writeFileSync(LEDF,JSON.stringify({next:1,transfers:[{value:'1'}]}));
  const LED=createLedger({pub,token:USDC,wallet:W,vault:W,paymasters:[],names:{},owner:OWNER,fromBlock:1,file:LEDF});
  const LIM=createPublicLimits({plan:async()=>({}),confirm:async()=>({valid:false}),current:async()=>({}),script:()=>'',base:()=>'http://fork.invalid'});
  const OPAY=createOwnerPay({enabled:true,store:S,save,resolveTenant:async()=>null});
  S.phoneSession??={};const PS=createPhoneSession({phone:{active:()=>PH.active()},wallet:W,store:S.phoneSession,save,readState:async()=>({})});
  const parts=mainnetEraseParts({S,save,ownerPay:OPAY,phone:PH,ledgerCache:LED,limits:LIM,trustOwner:O,getDb:()=>engine.ledger.db});
  const ERASE=createUserDataEraser({enabled:true,resolveTenant:async req=>PS.check(req)?{wallet:W,phone:PH}:null,parts});
  const readBody=async req=>{let b='';for await(const c of req)b+=c;try{return b?JSON.parse(b):{};}catch{return {};}};
  const srv=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');if(await PS.handle(req,res,u,{readBody,ip:'t'}))return;if(await ERASE.handle(req,res,u,{readBody}))return;res.writeHead(404);res.end();});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const B=`http://127.0.0.1:${srv.address().port}`;
  const post=async(p,body,tok)=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...(tok?{authorization:'Bearer '+tok}:{})},body:JSON.stringify(body??{})});return [r.status,await r.json().catch(()=>({}))];};
  const session=async key=>{const [,c]=await post('/phone/session/challenge');assert.equal(c.digest,sessionDigest(W,c.nonce));return post('/phone/session',{nonce:c.nonce,...sign(c.digest,key)});};
  try{
    // --- authentication ---
    let [code,o]=await post('/user/erase/challenge');assert.equal(code,401,'no session -> 401');
    [code,o]=await post('/user/erase',{nonce:'x',phrase:'DELETE'});assert.equal(code,401);
    [code,o]=await post('/user/erase/challenge',{},'kps_'+'A'.repeat(43));assert.equal(code,401,'forged token -> 401');
    [code,o]=await session(attacker);assert.equal(code,403,'a key that is not the enrolled phone gets no session');
    [code,o]=await session(k);assert.equal(code,200);const tok=o.token;
    [code,o]=await post('/user/erase/challenge',{},tok);assert.equal(code,200);assert.equal(o.digest,eraseDigest(W,o.nonce));
    let [c2,o2]=await post('/user/erase',{nonce:o.nonce,phrase:'DELETE',...sign(o.digest,attacker)},tok);assert.equal(c2,403,'session alone is not enough: needs the phone signature');
    [c2,o2]=await post('/user/erase',{nonce:o.nonce,phrase:'DELETE',...sign(o.digest,k)},tok);assert.equal(c2,400,'challenge is single-use');
    [code,o]=await post('/user/erase/challenge',{},tok);[c2,o2]=await post('/user/erase',{nonce:o.nonce,phrase:'nope',...sign(o.digest,k)},tok);assert.equal(c2,400,'wrong phrase');
    assert.equal(O().api.list(O().cap).pending.length,1,'nothing erased by the failed attempts');assert.ok(S.oauth.tokens.t1);
    // --- the real erase ---
    [code,o]=await post('/user/erase/challenge',{},tok);[c2,o2]=await post('/user/erase',{nonce:o.nonce,phrase:'DELETE',...sign(o.digest,k)},tok);
    assert.equal(c2,200,JSON.stringify(o2));console.log('ERASED PARTS',o2.erased.join(','));
    const disk=JSON.parse(fs.readFileSync(SF));
    const empty=x=>x&&Object.keys(x).length===0;
    const report={
      ownerPayThisWallet:disk.ownerPay?.[W.toLowerCase()]===undefined, ownerPayOtherTenantKept:!!disk.ownerPay?.['0x000000000000000000000000000000000000beef'],
      phoneSessions:empty(disk.phoneSession.sessions), phoneEnrollment:disk.phone.active===null&&empty(disk.phone.pending),
      agentActivity:empty(disk.agentLastSeen), oauth:['clients','pending','codes','tokens'].every(k=>empty(disk.oauth[k])), oauthAgents:empty(disk.oauthAgents),
      limitsRecord:disk.capChangedAt===undefined&&LIM.pending()===null, permissionKept:JSON.stringify(disk.permission)===JSON.stringify(perm),
      trustRequestsFile:empty(JSON.parse(fs.readFileSync(TRF)).requests)&&O().api.list(O().cap).pending.length===0,
      ledgerCacheFile:!fs.existsSync(LEDF),
      ...Object.fromEntries(['intents','idempotency','claims','purchase_label','events'].map(t=>['sql_'+t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n===0])),
      sql_purchaseMetaMerchant:db.prepare('SELECT merchant_id FROM purchase_meta').get().merchant_id===null,
      sql_purchaseKeptMinimum:(()=>{const r=db.prepare('SELECT * FROM purchases').get();const j=JSON.parse(r.result);return r.amount==='250000'&&r.tx_hash==='0xaa'&&r.intent_id===null&&j.fee==='250'&&j.networkFee==='8563'&&j.digest==='0xdd'&&!('merchantResponse' in j);})(),
      sql_feeVaultAccountingUnchanged:JSON.stringify(['gas_debt','gas_recovery','op_charges','float_vouchers','float_sessions'].map(t=>{try{return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;}catch{return -1;}}))===JSON.stringify(gasBefore),
    };
    console.log('STORES',JSON.stringify(report));for(const [k2,v] of Object.entries(report))assert.equal(v,true,k2);
    // nothing identifying left on disk
    const all=fs.readFileSync(SF,'utf8')+fs.readFileSync(TRF,'utf8');for(const w of ['Synthetic','student@','VPS','oauth-claude','muse'])assert.ok(!all.includes(w),'left: '+w);
    // --- idempotent ---
    [code]=await post('/user/erase/challenge',{},tok);assert.equal(code,401,'old session is gone after erase');
    const snap=fs.readFileSync(SF,'utf8');const again=await ERASE.erase(W);assert.deepEqual(again,o2.erased);assert.equal(fs.readFileSync(SF,'utf8'),snap,'second erase changes nothing');
    console.log('IDEMPOTENT ok');
    // --- withdraw still works, straight from the wallet's owner (Base Account), no Kipurse server involved ---
    const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
    const wb=await bal(W),ob=await bal(OWNER);assert.ok(wb>0n,'wallet has USDC on the fork');
    const data=encodeFunctionData({abi:EXEC_ABI,functionName:'execute',args:[USDC,0n,encodeFunctionData({abi:ERC20,functionName:'transfer',args:[OWNER,wb]})]});
    await run([{to:W,data}],OWNER);
    assert.equal(await bal(W),0n);assert.equal((await bal(OWNER))-ob,wb);console.log('WITHDRAW ok',wb.toString(),'atomic USDC moved wallet -> owner');
  }finally{srv.close();}
});
