// Wrong-token rehearsal on a throwaway anvil fork of LIVE Base (never broadcasts to mainnet).
import test from 'node:test';import assert from 'node:assert/strict';
import {createPublicClient,createTestClient,http,parseAbi,keccak256,encodeAbiParameters,getAddress,pad,toHex} from 'viem';import {base} from 'viem/chains';
import {createDeposit,STRAY} from '../../src/v5/deposit.mjs';
const RPC=process.env.FORK_RPC;const pub=createPublicClient({chain:base,transport:http(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:http(RPC)});
const W=getAddress('0x000000000000000000000000000000000000dEaD');const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WA=parseAbi(['function ownerAtIndex(uint256) view returns (bytes)','function nextOwnerIndex() view returns (uint256)','function isOwnerAddress(address) view returns (bool)','function execute(address,uint256,bytes)']);
const E=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const bal=(t,a)=>t?pub.readContract({address:t,abi:E,functionName:'balanceOf',args:[a]}):pub.getBalance({address:a});
async function deal(token,who,amt){for(let s=0n;s<20n;s++){const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[who,s]));const old=await pub.getStorageAt({address:token,slot});
  await tc.setStorageAt({address:token,index:slot,value:pad(toHex(amt))});if(await bal(token,who)===amt)return;await tc.setStorageAt({address:token,index:slot,value:old??pad('0x0')});}throw Error('no slot '+token);}
const send=async(from,to,data,value=0n)=>{await tc.impersonateAccount({address:from});await tc.setBalance({address:from,value:10n**18n});
  const h=await tc.request({method:'eth_sendTransaction',params:[{from,to,data,value:toHex(value),gas:toHex(500000)}]});return pub.waitForTransactionReceipt({hash:h});};
test('wrong token sent to the Kipurse wallet: detected, returned only to owner #0, others cannot move it',{skip:RPC?false:'needs FORK_RPC'},async()=>{
  const n=await pub.readContract({address:W,abi:WA,functionName:'nextOwnerIndex'});const owners=[];for(let i=0n;i<n;i++){try{owners.push(await pub.readContract({address:W,abi:WA,functionName:'ownerAtIndex',args:[i]}));}catch{owners.push(null);}}
  console.log('owners',owners);const O=getAddress('0x'+owners[0].slice(-40));const SPM=getAddress('0x'+owners[1].slice(-40));
  const USDT=STRAY[1].addr;await deal(USDT,W,3_500_000n);await tc.setBalance({address:W,value:(await bal(null,W))+2_000_000_000_000_000n});
  const reg={get:w=>w.toLowerCase()===W.toLowerCase()?{wallet:W,owner:O}:null};
  const D=createDeposit({reg,token:USDC,script:()=>'',usdcOf:a=>bal(USDC,a),qr:async()=>'',timeoutMs:20000,strayOf:async w=>{const v=await Promise.all(STRAY.map(x=>bal(x.addr,w).catch(()=>0n)));return Object.fromEntries(STRAY.map((x,i)=>[x.sym,v[i]]));}});
  const get=async url=>{let b='',code;await D.handle({method:'GET',headers:{'accept-language':'zh-CN'}},{writeHead(c){code=c;},end(x){b=String(x);}},new URL('http://x'+url));return {code,b};};
  const s=JSON.parse((await get('/deposit?w='+W+'&stray=1')).b);console.log('stray',s.stray);assert.ok(s.stray.find(x=>x.sym==='USDT'&&x.amount==='3500000'));assert.ok(s.stray.find(x=>x.sym==='ETH'));
  const page=(await get('/deposit?w='+W)).b;assert.match(page,/收到了 3\.5 USDT，不能用于 AI 支付/);
  // stranger and the SPM-owner-as-impersonated EOA are irrelevant; a non-owner cannot call execute
  const evil='0x000000000000000000000000000000000000dEaD';const ru=JSON.parse((await get('/deposit?w='+W+'&ret=USDT')).b);
  await assert.rejects(send(evil,W,ru.calls[0].data).then(r=>{if(r.status!=='success')throw Error('reverted');}));
  const oU0=await bal(USDT,O),oE0=await bal(null,O),wUsdc0=await bal(USDC,W);
  const r1=await send(O,W,ru.calls[0].data);assert.equal(r1.status,'success');console.log('USDT return gas',r1.gasUsed);
  assert.equal(await bal(USDT,W),0n);assert.equal(await bal(USDT,O)-oU0,3_500_000n);
  const re=JSON.parse((await get('/deposit?w='+W+'&ret=ETH')).b);const wE=BigInt(re.amount);
  await tc.setBalance({address:O,value:10n**18n});const oE1=await bal(null,O);const r2=await send(O,W,re.calls[0].data);assert.equal(r2.status,'success');console.log('ETH return gas',r2.gasUsed);
  assert.equal(await bal(null,W),0n);const gasCost=r2.gasUsed*r2.effectiveGasPrice;assert.equal(await bal(null,O)-oE1+gasCost,wE);
  assert.equal(await bal(USDC,W),wUsdc0,'USDC untouched');assert.equal((await get('/deposit?w='+W+'&ret=USDT')).code,409);
  assert.doesNotMatch((await get('/deposit?w='+W)).b,/id=stray/);
  // V3 approver (owner #2): rejects anything that is not a Kipurse typed approval (e.g. any user-op hash)
  if(owners[2]){const V3=getAddress('0x'+owners[2].slice(-40));const r=await pub.readContract({address:V3,abi:parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']),functionName:'isValidSignature',args:[keccak256('0x01'),encodeAbiParameters([{type:'uint8'},{type:'bytes'},{type:'uint256'},{type:'uint256'}],[3,'0x',1n,1n])]}).catch(()=>'revert');console.log('V3 random hash ->',r);assert.notEqual(r,'0x1626ba7e');}
  console.log('SPM owner',SPM,'(Coinbase SpendPermissionManager: moves only permission.token; Kipurse adapter requires token==USDC)');});
