import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {ownAddrHtml,shortAddr} from '../src/v5/addr-display.mjs';
const A='0x1111aB12cD34eF56001122334455667788990000'.slice(0,38)+'bEEF';
test('own address: shortened by default, full only behind 显示完整地址',()=>{const h=ownAddrHtml(A,(z)=>z);assert.equal(shortAddr(A),'0x1111…bEEF');
  const before=h.split('<details')[0];assert.ok(before.includes('0x1111…bEEF'));assert.ok(!before.includes(A));assert.match(h,/<details[^>]*><summary>显示完整地址<\/summary>/);});
test('own address on web pages goes through ownAddrHtml (wallet / approver never printed raw)',()=>{
  for(const [f,re] of [['src/v5/onboard.mjs',/class=mono>\$\{esc\(W\)\}/],['src/v5/phone-signer.mjs',/class=mono>\$\{esc\((W|e\.approver|r\.approver)\)\}/],['src/v5/deposit.mjs',/<div class=addr>\$\{esc\(W\)\}/]]){
    const s=fs.readFileSync(f,'utf8');assert.doesNotMatch(s,re,f);assert.match(s,/ownAddrHtml\(/,f);}});
test('payee address stays FULL before trust approval',()=>{const s=fs.readFileSync('src/v5/trust-approve-public.mjs','utf8');assert.match(s,/class=mono>\$\{esc\(r\.payee\)\}/);assert.doesNotMatch(s,/shortAddr\(r\.payee\)|ownAddrHtml\(r\.payee/);});
test('no 签名 / 网络费 on Kipurse web pages',()=>{const files=[...fs.readdirSync('src/v5').filter(f=>f.endsWith('.mjs')).map(f=>'src/v5/'+f),...['consent','static'].flatMap(d=>fs.readdirSync('owner-sign/'+d).filter(f=>f.endsWith('.js')).map(f=>`owner-sign/${d}/${f}`)),'kit/oauth.mjs','mainnet/mainnet-owner-launch.mjs'];
  for(const f of files){const s=fs.readFileSync(f,'utf8');assert.ok(!s.includes('签名'),f+' has 签名');assert.ok(!s.includes('网络费'),f+' has 网络费');}});
