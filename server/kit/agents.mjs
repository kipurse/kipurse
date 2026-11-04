// SPDX-License-Identifier: AGPL-3.0-only
// Agent gallery: how each popular AI agent connects to the Kipurse MCP endpoint (researched Oct 2026; sources in AGENTS-CONNECT.md).
// Local CLIs on this Mac are configured automatically with execFile (no shell). The per-agent token lives only in the URL
// passed as an argv element / written to the agent's own config file; it is never logged or returned in errors.
import {execFile} from 'node:child_process';import fs from 'node:fs';import {join,dirname} from 'node:path';import {homedir} from 'node:os';import {fileURLToPath} from 'node:url';import {keyPack,oauthPack} from './client-packs.mjs';

const HOME=homedir(),KIT=dirname(dirname(fileURLToPath(import.meta.url)));
const BIN_DIRS=['/opt/homebrew/bin','/usr/local/bin',join(HOME,'.local/bin'),join(KIT,'codex-cli/node_modules/.bin'),'/usr/bin'];
export function findBin(names,exists=fs.existsSync){for(const n of [].concat(names))for(const d of BIN_DIRS){const p=join(d,n);if(exists(p))return p;}return null;}

// kind: local = CLI on this Mac (auto-configured, localhost URL); remote = cloud agent (needs public HTTPS URL); deeplink; native (iOS App Intents); custom; unsupported
export const CATALOG=[
  {id:'codex',name:'Codex',maker:'OpenAI',kind:'local',bin:'codex',how:'codex mcp add kipurse --url <URL>（Codex App 和 CLI 共用 ~/.codex/config.toml）'},
  {id:'claude-code',name:'Claude Code',maker:'Anthropic',kind:'local',bin:'claude',how:'claude mcp add --transport http --scope user kipurse <URL>'},
  {id:'gemini-cli',name:'Gemini CLI',maker:'Google',kind:'local',bin:'gemini',how:'gemini mcp add -s user --transport http kipurse <URL>'},
  {id:'antigravity',name:'Google Antigravity',maker:'Google',kind:'local',bin:'agy',how:'写入 ~/.gemini/config/mcp_config.json：mcpServers.kipurse.serverUrl = <URL>（App / IDE / CLI 共用）'},
  {id:'grok',name:'Grok Bot',maker:'xAI',kind:'local',bin:'grok',how:'grok mcp add --transport http kipurse <URL>；网页版 Grok 用 grok.com/connectors → New Connector → Custom，填公网 URL',remoteToo:true},
  {id:'cursor',name:'Cursor',maker:'Anysphere',kind:'deeplink',how:'点 cursor:// 安装链接（需要电脑上装了 Cursor）'},
  {id:'chatgpt',name:'ChatGPT',maker:'OpenAI',kind:'remote',how:'ChatGPT → Plugins → + → Add custom MCP server，填公网 HTTPS URL。官方说明：完整 MCP（含写操作）目前面向 Business / Enterprise / Edu。'},
  {id:'claude-desktop',name:'Claude 桌面版 / claude.ai',maker:'Anthropic',kind:'remote',how:'Customize → Connectors → Add → Custom → Web，填公网 HTTPS URL（从 Anthropic 云端连接）'},
  {id:'muse',name:'Muse',maker:'Meta',kind:'remote',how:'Muse 没有 MCP 设置页：在对话里让它“创建一个 Custom Connector”，把公网 URL 发给它；它在 Meta 云端电脑上建好并存成技能。Muse Code（终端版）在设置文件 mcp_servers 里加 streamable_http。'},
  {id:'apple',name:'Apple Intelligence / Siri',maker:'Apple',kind:'native',how:'Kipurse iPhone App 自带 App Intents：查余额、暂停 AI 付款、打开待批准、取回到我的钱包（Face ID）。在“快捷指令”或对 Siri 说“Kipurse 余额”。'},
  {id:'custom',name:'自己开发的 AI agent',maker:'',kind:'custom',how:'任何支持 MCP（Streamable HTTP）的程序：用 MCP 地址，或直接发 JSON-RPC 请求。'},
];

const run=(bin,args)=>new Promise(r=>execFile(bin,args,{timeout:30000,env:{...process.env,PATH:BIN_DIRS.join(':')+':'+(process.env.PATH||'')}},(e,out,err)=>r({ok:!e,out:String(out||''),err:String(err||'')})));
const scrub=(s,url)=>String(s).split(url).join('<URL>').replace(/\/mcp\/[A-Za-z0-9_-]{16,}/g,'/mcp/<token>').slice(0,400);
function backup(p){try{if(fs.existsSync(p)&&!fs.existsSync(p+'.bak-kipurse'))fs.copyFileSync(p,p+'.bak-kipurse');}catch{}}// keeps the PRE-Kipurse copy only
/** Remove any agent-config backup that still carries a Kipurse connection (token URL). Returns the number removed. */
export function scrubAgentBackups(home=HOME){let n=0;for(const p of [join(home,'.gemini/config/mcp_config.json'),join(home,'.codex/config.toml'),join(home,'.claude.json'),join(home,'.cursor/mcp.json')]){const b=p+'.bak-kipurse';
  try{if(fs.existsSync(b)&&/\/mcp\/|kipurse/i.test(fs.readFileSync(b,'utf8'))){fs.rmSync(b);n++;}}catch{}}return n;}

/** Configure a local agent with the kipurse MCP URL; returns {applied, verified, note} (never the URL). */
export async function applyLocal(id,url,{exec=run}={}){
  const a=CATALOG.find(x=>x.id===id);if(!a||a.kind!=='local')return {applied:false,verified:false,note:'不是本机 AI'};
  const bin=findBin(a.bin);if(!bin)return {applied:false,verified:false,note:`这台 Mac 上没找到 ${a.bin}，请先安装 ${a.name}`};
  if(id==='antigravity'){const p=join(HOME,'.gemini/config/mcp_config.json');fs.mkdirSync(dirname(p),{recursive:true});backup(p);
    let j={};try{j=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}j.mcpServers={...(j.mcpServers||{}),kipurse:{serverUrl:url}};
    fs.writeFileSync(p,JSON.stringify(j,null,2),{mode:0o600});const ok=JSON.parse(fs.readFileSync(p,'utf8')).mcpServers?.kipurse?.serverUrl===url;
    return {applied:true,verified:ok,note:ok?'已写入 Antigravity 配置；重开 Antigravity（或在 CLI 里 /mcp 刷新）即可':'写入后读回不一致'};}
  const add={codex:['mcp','add','kipurse','--url',url],'claude-code':['mcp','add','--transport','http','--scope','user','kipurse',url],
    'gemini-cli':['mcp','add','-s','user','--transport','http','kipurse',url],grok:['mcp','add','--transport','http','kipurse',url]}[id];
  const rm={codex:['mcp','remove','kipurse'],'claude-code':['mcp','remove','--scope','user','kipurse'],'gemini-cli':['mcp','remove','-s','user','kipurse'],grok:['mcp','remove','kipurse']}[id];
  if(id==='codex')backup(join(HOME,'.codex/config.toml'));
  await exec(bin,rm);const r=await exec(bin,add);
  if(!r.ok)return {applied:false,verified:false,note:'配置失败：'+scrub(r.err||r.out,url)};
  const l=await exec(bin,['mcp','list']);const verified=l.ok&&/kipurse/.test(l.out+l.err);
  return {applied:true,verified,note:verified?`${a.name} 已配置 kipurse；重开 ${a.name} 后就能用`:`已执行添加命令，但 “mcp list” 里没看到 kipurse`};
}

/** Copy-paste material for a remote / deeplink / custom agent. publicUrl is null when no HTTPS tunnel is running. */
export function remoteInfo(id,{localUrl,publicUrl,token,baseUrl,lang}){
  const a=CATALOG.find(x=>x.id===id);const u=publicUrl||null;
  const out={id,kind:a?.kind,how:a?.how,url:u,localUrl};
  if(a?.kind==='remote'||a?.remoteToo){out.needsPublic=true;if(!u)out.note='云端 AI 连不到你电脑上的 localhost。先在电脑上运行“Share to iPhone”打开临时 HTTPS 地址（地址每次重开会变，变了要重新连接）。';
    else out.note='这是临时 HTTPS 地址：隧道重开后会变，到时要重新连接。';}
  if(token){const kp=keyPack(id,{base:baseUrl,token,localUrl,lang});if(kp)Object.assign(out,kp);if(id==='muse'&&baseUrl)out.note='一般只要一步：复制 → 粘贴到 Muse。钥匙是 Muse 专用的，可以随时在这里换新（旧的立即作废）。';}
  {const op=oauthPack(id,baseUrl);if(op&&!out.key)Object.assign(out,op);}
  if(id==='cursor'){const b64=Buffer.from(JSON.stringify({url:localUrl})).toString('base64');out.deeplink=`cursor://anysphere.cursor-deeplink/mcp/install?name=kipurse&config=${encodeURIComponent(b64)}`;}
  if(id==='custom'){const t=u||localUrl;
    out.curl=`curl -s ${t} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
    out.sdk=`import {Client} from '@modelcontextprotocol/sdk/client/index.js';\nimport {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';\nconst c=new Client({name:'my-agent',version:'1.0.0'});\nawait c.connect(new StreamableHTTPClientTransport(new URL('${t}')));\nconsole.log(await c.callTool({name:'kipurse_wallet_status',arguments:{}}));`;}
  return out;
}

/** Map a legacy key name to a gallery agent type ("Codex (Mac)" -> codex). */
export function kindOf(name){const n=String(name||'').toLowerCase();
  for(const a of CATALOG){if(a.id==='custom')continue;if(n.startsWith(a.name.toLowerCase())||n.startsWith(a.id))return a.id;}
  if(n.startsWith('claude code'))return 'claude-code';return null;}

/** Remove the kipurse entry from a local agent's config (used on disconnect). */
export async function removeLocal(id,{exec=run}={}){
  const a=CATALOG.find(x=>x.id===id);if(!a||a.kind!=='local')return null;const bin=findBin(a.bin);if(!bin)return {removed:false};
  if(id==='antigravity'){const p=join(HOME,'.gemini/config/mcp_config.json');try{const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.mcpServers?.kipurse){backup(p);delete j.mcpServers.kipurse;fs.writeFileSync(p,JSON.stringify(j,null,2),{mode:0o600});}}catch{}return {removed:true};}
  const rm={codex:['mcp','remove','kipurse'],'claude-code':['mcp','remove','--scope','user','kipurse'],'gemini-cli':['mcp','remove','-s','user','kipurse'],grok:['mcp','remove','kipurse']}[id];
  if(id==='codex')backup(join(HOME,'.codex/config.toml'));const r=await exec(bin,rm);return {removed:r.ok};}
