// SPDX-License-Identifier: AGPL-3.0-only
// Pre-answered connection packs: for every AI client, the exact value of every field it can show, so an ordinary user never
// answers a technical question. base = stable public origin (e.g. https://mcp.example.com). OAuth clients get the key-free URL
// (the user approves on the phone); key clients get a per-agent key that the server accepts in any header / query / path.
const NO_ASK='不要问我任何技术问题，所有选项都用下面给的值或默认值。';
export const OAUTH_FIELDS=base=>[{k:'名称 Name',v:'Kipurse'},{k:'地址 URL',v:base+'/mcp'},{k:'认证 Authentication',v:'OAuth（默认那项；Client ID / Secret 留空）'}];
/** Static packs for OAuth-capable web clients (no key; shown from the gallery without generating anything). */
export function oauthPack(id,base){if(!base)return null;const u=base+'/mcp';
  const after='页面会跳到 Kipurse 授权页 → 点「在 iPhone 上用 Kipurse App 批准」→ 在 App 的「待批准」里 Face ID 同意。';
  const P={
    chatgpt:{where:'ChatGPT → 设置 → Apps（或 Plugins）→ Create / Add custom MCP server',fields:[...OAUTH_FIELDS(base),{k:'说明 Description（可选）',v:'我的 Kipurse 钱包'},{k:'“我信任这个应用”勾选框',v:'勾上'}]},
    'claude-desktop':{where:'claude.ai 或 Claude 桌面版 → Customize → Connectors → Add custom connector',fields:[{k:'名称 Name',v:'Kipurse'},{k:'远程 MCP 服务器 URL',v:u},{k:'高级设置 OAuth Client ID / Secret',v:'留空'}]},
    grok:{where:'grok.com → Connectors → New Connector → Custom',fields:[...OAUTH_FIELDS(base)]},
  }[id];if(!P)return null;
  return {fields:P.fields,steps:[`打开 ${P.where}`,'照下面每一栏填（每栏右边一键复制），其他不认识的选项都保持默认',after,'回到 AI，说“查一下我的 Kipurse 钱包”验证'],url:u};}
/** Key packs, generated together with a fresh per-agent key. */
export function keyPack(id,{base,token,localUrl,lang}){
  if(id==='muse'&&base){const url=base+'/mcp',keyUrl=`${url}?key=${token}`;
    const msg=lang==='en'?`Please connect my Kipurse wallet (MCP). Don't ask me any technical questions; use exactly these values or the defaults.
- Name: kipurse
- Type: remote MCP, transport Streamable HTTP (if that fails use SSE: ${base}/sse?key=${token})
- URL (key included, use as is; no OAuth, no credential vault needed): ${keyUrl}
- If your platform must store the key in its vault: URL ${url}, header Authorization: Bearer <key>, key = ${token} (the server also accepts X-API-Key or ?key= — pick any, don't ask me)
After connecting: list the tools, call kipurse_wallet_status to verify read-only, and save this connection as a skill. Always ask me before any payment.`:`请帮我连接 Kipurse 钱包（MCP）。${NO_ASK}
- 名称：kipurse
- 类型：remote MCP，传输 Streamable HTTP（不行再用 SSE：${base}/sse?key=${token}）
- 地址（已带钥匙，直接用，不需要 OAuth，不需要凭证库）：${keyUrl}
- 如果你的平台一定要把钥匙放进凭证库：地址填 ${url}，请求头 Authorization: Bearer <钥匙>，钥匙 = ${token}（服务器也接受 X-API-Key 或 ?key=，任选其一，不用问我）
连好后：列出工具，调用 kipurse_wallet_status 只读验证，把这个连接存成技能。以后任何付款前都要先问我。`;
    return {copyAll:msg,key:token,url,keyUrl,
      fields:[{k:'凭证库 · 钥匙 / 密钥 / Secret',v:token},{k:'凭证库 · 地址 / URL（如果有这一栏）',v:url},{k:'凭证库 · 请求头 / Header（如果有这一栏）',v:'Authorization'},{k:'凭证库 · 类型（如果有）',v:'Bearer'}],
      steps:['点「一键复制给 Muse」，到 Muse 对话里粘贴发送（就这一步）','通常 Muse 会直接连好并显示钱包状态','万一 Muse 弹出「安全凭证存储库 · 添加」：点「添加」，回 Kipurse 点「复制钥匙」，粘到钥匙那一栏保存（其他栏有的话照下面填）','Kipurse 的 AI 页里 Muse 显示「在线」就完成了']};}
  if(id==='custom'){const t=base?`${base}/mcp`:localUrl.replace(/\/mcp\/.*/,'/mcp');
    const json=JSON.stringify({mcpServers:{kipurse:{type:'http',url:t,headers:{Authorization:`Bearer ${token}`}}}},null,2);
    return {copyAll:json,key:token,url:t,fields:[{k:'MCP 地址',v:t},{k:'Authorization 请求头',v:`Bearer ${token}`},{k:'或者：带钥匙的地址（无需请求头）',v:`${t}?key=${token}`},{k:'旧客户端 SSE 地址',v:`${(base??'http://localhost')}/sse?key=${token}`}],
      steps:['把「一键复制」的 JSON 放进你程序的 MCP 配置（大多数客户端通用的 mcpServers 格式）','钥匙放在 Authorization / X-API-Key / ?key= / 地址路径 任何一处都行，服务器自动识别']};}
  return null;}
