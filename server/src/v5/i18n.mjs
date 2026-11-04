// SPDX-License-Identifier: AGPL-3.0-only
// ONE language per response (owner rule): Chinese iPhone -> 100% Chinese, anything else -> 100% English, never "中文 / English".
// Order: ?lang=zh|en (the app adds it from the iPhone language) -> x-kp-lang header (app API calls) -> Accept-Language -> English.
export const CJK=/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
export function langOf(req,u){
  if(req?.kpLang)return req.kpLang;
  let q=null;try{q=(u??new URL(req?.url??'/','http://x')).searchParams.get('lang');}catch{}
  if(q==='zh'||q==='en')return q;
  const h=String(req?.headers?.['x-kp-lang']??'');if(h==='zh'||h==='en')return h;
  const a=String(req?.headers?.['accept-language']??'').split(',')[0].trim().toLowerCase();
  return a.startsWith('zh')?'zh':'en';
}
export const X=lang=>(zh,en)=>lang==='zh'?zh:en;
// Server messages that reach users (JSON detail / summary / thrown errors). Keys = the Chinese text; values = English.
export const EN={
  '请用刚才登录的那个 Coinbase 账户':'Use the Coinbase account you just signed in with',
  '找到你已有的启付钱包':'Found your existing Kipurse wallet','创建你的启付钱包':'Create your Kipurse wallet',
  '每笔、每天、总额都要是正数（最多 6 位小数）':'Per payment, per day and total must be positive numbers (up to 6 decimals)',
  '每笔不能大于每天':'Per payment can’t be more than per day','每天不能大于总额':'Per day can’t be more than the total',
  '总额最多 1,000,000 USDC（一百万）':'The total can be at most 1,000,000 USDC','期限 1–365 天':'The term must be 1–365 days',
  '取回内容不对，已停止':'The withdrawal details don’t match. Stopped.',
  '请求已过期或已处理，请回到 AI 重新连接':'The request has expired or was already handled. Go back to your AI and connect again.',
  '这台手机不是确认人':'This phone isn’t a signer.','手机确认人已不在钱包里（已撤销）':'The phone signer is no longer in the wallet (revoked).',
  '确认不是这台已登记手机的':'The signature isn’t from the enrolled phone.','请求已处理':'The request was already handled.',
  '确认不是钱包主人的 Base Account':'The signature isn’t from the wallet owner’s Base Account.',
  '未知的客户端（client_id）':'This AI app isn’t registered with your wallet (unknown client).',
  '余额是 0，没有可取回的 USDC':'The balance is 0. There is no USDC to withdraw.',
  '这次的上限超过手机确认允许的范围，请用 Base Account 批准':'These limits are above what the phone signer may approve. Approve with your Base Account.',
  '钱包余额不够这笔（含手续费和手续费）。先充值再付。':'The wallet balance can’t cover this payment (including fees). Add money first.',
  '钱包已暂停，先在 App 里恢复再付。':'The wallet is paused. Resume it in the app first.',
  'AI 授权已过期或还没生效，先在 App 里续期。':'The AI authorization has expired or hasn’t started. Renew it in the app first.',
  '这笔超过了手机快速批准的范围，又不在钱包限额内可直接付的收款方里。请先把收款方加入信任名单，或调高钱包限额。':'This payment is above the phone’s quick-approve range and the payee isn’t one the wallet can pay directly. Trust the payee first, or raise the wallet limits.',
};
// Pattern messages (Chinese with values) -> English.
const EN_RE=[
  [/^这笔超过了你在 App 里设的钱包限额/, ()=> 'This payment is over the wallet limits you set in the app (per payment / per day / total). You can raise them in the app.'],
];
export function en(s){
  if(typeof s!=='string'||!CJK.test(s))return s;
  if(EN[s])return EN[s];
  const bi=/^(.*?[\u3400-\u9fff].*?)\s+\/\s+([^\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+)$/.exec(s);if(bi)return bi[2];   // legacy "中文 / English"
  for(const [re,f] of EN_RE){const m=re.exec(s);if(m)return f(m);}
  return null;   // unknown Chinese: caller substitutes a generic English line
}
export function zhOnly(s){if(typeof s!=='string')return s;const bi=/^(.*?[\u3400-\u9fff].*?)\s+\/\s+[^\u3400-\u9fff]+$/.exec(s);return bi?bi[1]:s;}
const GENERIC='Something went wrong. Please try again.';
/** Rewrites user-facing string fields of a JSON reply into the request language (recursively; addresses / hashes untouched). */
export function localizeJSON(lang,o,depth=0){
  if(depth>6||o==null)return o;
  if(typeof o==='string')return lang==='zh'?zhOnly(o):(CJK.test(o)?(en(o)??GENERIC):o);
  if(Array.isArray(o))return o.map(x=>localizeJSON(lang,x,depth+1));
  if(typeof o==='object'){const r={};for(const [k,v] of Object.entries(o))r[k]=(k==='zh'&&lang!=='zh')?v:localizeJSON(lang,v,depth+1);return r;}
  return o;
}
/** Wrap an http handler: sets req.kpLang and localizes every JSON reply. HTML pages render their own single language. */
export function withLang(handler){
  return async(req,res)=>{
    req.kpLang=langOf(req);
    let path='/';try{path=new URL(req.url,'http://x').pathname;}catch{}
    if(/^(\/t\/0x[0-9a-fA-F]{40})?\/(mcp|v1|sse|\.well-known|oauth\/(token|register|revoke))(\/|$)/i.test(path))return handler(req,res);   // also per-wallet /t/<wallet>/... (was missed: localized MCP/OAuth JSON)   // agent API: machine text, not localized here
    const end=res.end.bind(res),wh=res.writeHead.bind(res);let ctype='';
    res.writeHead=(c,...a)=>{const h=a.find(x=>x&&typeof x==='object'&&!Array.isArray(x));if(h)for(const [k,v] of Object.entries(h))if(k.toLowerCase()==='content-type')ctype=String(v);return wh(c,...a);};
    res.end=(body,...rest)=>{
      try{const ct=ctype||String(res.getHeader?.('content-type')??'');
        if(body!=null&&/application\/json/.test(ct)){const s=Buffer.isBuffer(body)?body.toString('utf8'):String(body);
          if(CJK.test(s)){const out=JSON.stringify(localizeJSON(req.kpLang,JSON.parse(s)));return end(out,...rest);}}
      }catch{}
      return end(body,...rest);
    };
    return handler(req,res);
  };
}
