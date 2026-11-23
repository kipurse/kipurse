// t1243 (handbook §6#113): the owner-ask approve replies right after the payment (trust {state:'submitting'}); the trust (+ the V5.4 grant,
// verified before it is stored) lands in the background. Tests poll the ask record for the final trust result - assertions stay as strict as before.
export async function waitTrust(asks,id,{timeoutMs=20000,pollMs=5}={}){const t0=Date.now();
  for(;;){const a=asks.get(id);const t=a?.result?.trust;if(t&&t.state!=='submitting')return t;
    if(Date.now()-t0>timeoutMs)throw new Error('trust still '+(t?.state??'missing')+' after '+timeoutMs+' ms');await new Promise(r=>setTimeout(r,pollMs));}}
