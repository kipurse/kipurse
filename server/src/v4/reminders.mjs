// Expiry reminders (code only). Nothing here schedules anything: callers (wallet_status, limits, owner UI, an
// operator's own cron if the owner ever wants one) ask "what is due now?" and get a deterministic answer.
const CT=s=>new Date(s*1000).toLocaleString('zh-CN',{timeZone:'America/Chicago',hour12:false})+' (芝加哥时间)';
/** permission: {start,end} (unix s). Returns status, time left and the reminders that are due at `now`. */
export function expiryReminders(permission,{now=Math.floor(Date.now()/1000),thresholdsDays=[7,1]}={}){
  const start=Number(permission.start),end=Number(permission.end),left=end-now;
  const base={endsAt:end,endsAtCT:CT(end),secondsLeft:Math.max(0,left),daysLeft:Math.max(0,left/86400).toFixed(2)};
  if(now<start)return {...base,status:'not_started',due:[],message:`授权尚未开始，开始时间 ${CT(start)}。`};
  if(left<=0)return {...base,status:'expired',due:[{level:'expired',message:`授权已于 ${CT(end)} 到期，agent 已不能付款；余额仍在钱包里，主人随时可提回。续用需要主人重新签一次新授权。`}],
    message:'授权已到期（不会自动续期）。'};
  const due=[...thresholdsDays].sort((a,b)=>a-b).filter(d=>left<=d*86400).slice(0,1)
    .map(d=>({level:`T-${d}`,message:`授权将在 ${CT(end)} 到期（剩 ${(left/86400).toFixed(1)} 天）。到期后 agent 自动停止付款，不会自动续期；如需继续，请主人重新签一次授权（可选 30/90/180/365 天）。`}));
  return {...base,status:due.length?'expiring':'active',due,message:due.length?due[0].message:`授权有效，至 ${CT(end)}。`};
}
