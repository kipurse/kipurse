// t619u (owner decision): the user's OWN addresses (Kipurse wallet, Base Account, phone approver) are shortened by default
// (0x1111…bEEF); the full address only after an explicit 显示完整地址 / 复制. PAYEE addresses are always shown in full.
export const shortAddr=a=>{a=String(a??'');return a.length>12?`${a.slice(0,6)}…${a.slice(-4)}`:a;};
const E=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function ownAddrHtml(a,t=(z)=>z){return `<span class=own-short>${E(shortAddr(a))}</span><details class=own-full><summary>${t('显示完整地址','Show full address')}</summary><span class=mono>${E(a)}</span></details>`;}
