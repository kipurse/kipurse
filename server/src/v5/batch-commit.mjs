// SPDX-License-Identifier: AGPL-3.0-only
// t621 #1: the commitment the Kipurse APP computes over a Base Account batch it decoded and checked (Swift: BatchVerify.commitment).
// Pages refuse to send any wallet_sendCalls whose commitment differs (owner-sign/guard/kpvh.js). Pure; no secrets.
import {createHash} from 'node:crypto';
export const canon=({chainId,from,calls})=>'kpbatch1|'+Number(chainId)+'|'+String(from).toLowerCase()+'|'+(calls??[]).map(c=>String(c.to).toLowerCase()+','+BigInt(c.value||0).toString()+','+String(c.data||'0x').toLowerCase()).join(';');
export const commitment=b=>createHash('sha256').update(canon(b)).digest('hex');
