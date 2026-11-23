// t1188 (§6#88): the one-time deploy page must work like the proven sign pages on the owner's iPhone: HEAD 200 (SDK COOP check),
// another app's built-in browser is recognised and calmly sent to Safari (no button there), the tap opens Coinbase first, no loops.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Readable} from 'node:stream';import {getAddress} from 'viem';
import {loadV53Plan,createDeployV53} from '../src/v5/deploy-v53.mjs';import {readRaw} from '../src/v5/router.mjs';
const plan=loadV53Plan(new URL('../mainnet/v53-deploy-plan.json',import.meta.url).pathname);const O='0x4242b022A8296cB18B0E0b1Cb9879C518170A718';
const mkPub=(code={})=>({getCode:async({address})=>code[getAddress(address)]??'0x',getGasPrice:async()=>6000000n,readContract:async()=>988700n});
const call=async(D,method,path,lang='zh-CN')=>{let code,h,b;const req=Object.assign(Readable.from([]),{method,headers:{'accept-language':lang}});
  await D.handle(req,{writeHead(c,hh){code=c;h=hh;},end(x){b=x;}},new URL('https://pay.kipurse.com'+path));return {code,h,b};};
const SRC=fs.readFileSync(new URL('../owner-sign/consent/deploy-v53.js',import.meta.url),'utf8');
const inApp=new Function('return '+SRC.slice(SRC.indexOf('function inAppBrowser'),SRC.indexOf('\nconst link=')))();
const UA={
  safari:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  wkwebview:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  grok:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Grok/1.4',
  wechat:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50',
  chromeios:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
  ipados:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  mac:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  desktopChrome:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'};
test('in-app browsers are recognised; Safari, the Safari view and full browsers are not',()=>{
  assert.equal(inApp(UA.safari,5),false);assert.equal(inApp(UA.chromeios,5),false);assert.equal(inApp(UA.mac,0),false);assert.equal(inApp(UA.desktopChrome,0),false);
  assert.equal(inApp(UA.wkwebview,5),true);assert.equal(inApp(UA.grok,5),true);assert.equal(inApp(UA.wechat,5),true);assert.equal(inApp(UA.ipados,5),true);});
test('HEAD answers 200 like the proven sign host (no COOP header), with no body',async()=>{const D=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:{registerDeployV53:()=>'dv53-x'},readRaw});
  const h=await call(D,'HEAD','/deploy-v53');assert.equal(h.code,200);assert.equal(h.b,undefined);assert.ok(!Object.keys(h.h).some(k=>/cross-origin-opener/i.test(k)));
  const g=await call(D,'GET','/deploy-v53');assert.equal(g.code,200);assert.ok(!Object.keys(g.h).some(k=>/cross-origin-opener/i.test(k)));});
test('page: hidden "open in Safari" card (open + copy) and a calm help card; zh/en; no 签名 / 网络费',async()=>{const D=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:{},readRaw});
  const zh=(await call(D,'GET','/deploy-v53')).b;assert.match(zh,/id=safari style="display:none"/);assert.match(zh,/请在 Safari 里打开这个页面/);assert.match(zh,/在 Safari 中打开/);assert.match(zh,/复制链接/);
  assert.match(zh,/id=help style="display:none"/);assert.match(zh,/没有扣任何钱/);assert.doesNotMatch(zh,/签名|网络费/);
  const en=(await call(D,'GET','/deploy-v53','en-US')).b;assert.match(en,/Please open this page in Safari/);assert.match(en,/Copy link/);assert.doesNotMatch(en,/[\u4e00-\u9fff]/);
  const done=(await call(createDeployV53({plan,owner:O,pub:mkPub({[plan.factory]:'0x60',[plan.adapter]:'0x60'}),sponsor:{},readRaw}),'GET','/deploy-v53')).b;assert.doesNotMatch(done,/id=safari|<button/);});
test('script: no automatic retry / loop; the tap opens Coinbase first (batch prepared at load); only one send, via the paymaster',()=>{
  const go=SRC.slice(SRC.indexOf('go.onclick='));assert.ok(go.indexOf("eth_requestAccounts")<go.indexOf('await',go.indexOf('try{')+40)+400);
  const beforeAcc=go.slice(0,go.indexOf('eth_requestAccounts'));assert.doesNotMatch(beforeAcc.replace(/await prov\(\)\.request\(\{method:$/,''),/await (post|prep|sha|pinned|fetch)/);
  assert.doesNotMatch(SRC,/setInterval|location\.reload|\.click\(\)/);assert.equal((SRC.match(/wallet_sendCalls/g)??[]).length,1);
  const B=fs.readFileSync(new URL('../owner-sign/static/deploy-v53.js',import.meta.url),'utf8');assert.ok(B.includes('KPVH-GUARD v1'));assert.match(B,/x-safari-/);assert.match(B,/MicroMessenger/);});
