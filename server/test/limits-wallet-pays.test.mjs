import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {limitsChangeFee,feeRefundCall} from '../src/v5/limits-fee.mjs';import {WHY_FEE,gasRoute} from '../src/v5/limits-public.mjs';
const base={callGas:100000n,gasPriceWei:10_000_000n,ethUsd8:300000000000n};
test('wallet pays: low wallet -> wallet_low',()=>{const f=limitsChangeFee({...base,payerUSDC:10n**6n,walletUSDC:0n});assert.equal(f.reason,'wallet_low');assert.equal(f.canPayUSDC,false);assert.equal(gasRoute({pm:null,fee:f}).route,null);});
test('wallet pays: no BA float -> float_low',()=>{const f=limitsChangeFee({...base,payerUSDC:0n,walletUSDC:10n**6n});assert.equal(f.reason,'float_low');});
test('wallet pays: both ok -> usdc route, refund gas included',()=>{const f=limitsChangeFee({...base,payerUSDC:10n**6n,walletUSDC:10n**6n});assert.equal(f.reason,null);assert.equal(gasRoute({pm:null,fee:f}).route,'usdc');assert.equal(f.gas,295000n);});
test('refund call = wallet.execute(USDC.transfer(owner,fee))',()=>{const c=feeRefundCall({wallet:'0x'+'1'.repeat(40),token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',owner:'0x'+'2'.repeat(40),fee:7258n});assert.equal(c.to.toLowerCase(),'0x'+'1'.repeat(40));assert.match(c.data,/^0xb61d27f6/);assert.match(c.data,/a9059cbb/);assert.match(c.data,/1c5a/);});
test('beginner explanation zh/en, no ETH ask',()=>{assert.match(WHY_FEE.zh,/区块链上.*连我们也改不了.*不加价/);assert.match(WHY_FEE.en,/blockchain/);assert.doesNotMatch(WHY_FEE.zh+WHY_FEE.en,/请先准备 ETH|add ETH/);});
