// SPDX-License-Identifier: AGPL-3.0-only
// Real-world spending rail: single-use, merchant-locked virtual cards funded from the agent wallet.
// Flow: agent asks for a card for one purchase (merchant + amount) -> Kipurse pays the card issuer's USDC funding address
// THROUGH THE NORMAL ENGINE (so every owner cap, trust rule, approval and receipt applies) -> the issuer returns a card
// locked to that merchant/category and amount -> the card is used at the till / checkout (or Apple Pay) -> leftover is
// returned to the wallet by the issuer. Providers plug in behind one interface; MockCardProvider is for test mode only.
import {randomBytes,createHash} from 'node:crypto';import {plainStore} from './at-rest.mjs';
export const CATEGORIES=['food_drink','groceries','transport','shopping','digital','travel','other'];
/** Provider interface: {name, fundingAddress, issue({cardId,amountAtomic,merchant,category}), authorize(cardId,{merchant,amountAtomic,category}), close(cardId)} */
export function createMockCardProvider({fundingAddress,now=()=>Math.floor(Date.now()/1000)}){
  if(!fundingAddress)throw Error('mock card provider needs a test funding address');
  const cards=new Map();
  return {name:'mock (test mode)',test:true,get fundingAddress(){return typeof fundingAddress==='function'?fundingAddress():fundingAddress;},
    issue({cardId,amountAtomic,merchant,category}){const pan='4000'+String(BigInt('0x'+createHash('sha256').update(cardId).digest('hex').slice(0,12))).padStart(12,'0').slice(0,12);
      const c={cardId,last4:pan.slice(-4),panMasked:'•••• •••• •••• '+pan.slice(-4),expires:new Date((now()+3600)*1000).toISOString(),cvc:'***',limitAtomic:String(amountAtomic),merchant,category,status:'active',spentAtomic:'0',walletPass:'apple-pay-provisioning-not-available-in-test'};
      cards.set(cardId,c);return {...c};},
    authorize(cardId,{merchant,amountAtomic,category}){const c=cards.get(cardId);if(!c)return {approved:false,reason:'unknown_card'};if(c.status!=='active')return {approved:false,reason:'card_'+c.status};
      if(c.merchant&&merchant&&String(merchant).toLowerCase().indexOf(String(c.merchant).toLowerCase())<0&&String(c.merchant).toLowerCase().indexOf(String(merchant).toLowerCase())<0)return {approved:false,reason:'merchant_locked'};
      if(c.category&&category&&c.category!==category)return {approved:false,reason:'category_locked'};
      if(BigInt(amountAtomic)>BigInt(c.limitAtomic)-BigInt(c.spentAtomic))return {approved:false,reason:'over_card_limit'};
      c.spentAtomic=String(BigInt(c.spentAtomic)+BigInt(amountAtomic));c.status='used';return {approved:true,authCode:randomBytes(3).toString('hex').toUpperCase(),leftoverAtomic:String(BigInt(c.limitAtomic)-BigInt(c.spentAtomic))};},
    close(cardId){const c=cards.get(cardId);if(c&&c.status==='active')c.status='closed';return c?{...c}:null;}};}
export function createCardRail({provider,store=plainStore,file,now=()=>Math.floor(Date.now()/1000)}){
  let S=store.readJson(file,null)??{cards:{}};const save=()=>store.writeJson(file,S);
  return {provider:provider?.name??null,test:!!provider?.test,
    /** pay: async ({to,amountAtomic,merchant,orderRef,idempotencyKey}) => engine result */
    async create({merchant,amount,amountAtomic,category='other',note='',agentId},pay){
      if(!provider)return {state:'rejected',reason:'no_card_provider',detail:'real-world cards are not enabled yet (the owner picks a card issuer first)'};
      if(!merchant||String(merchant).length>80)return {state:'rejected',reason:'bad_merchant',detail:'say where you will pay, e.g. "Boba Guys, Los Angeles"'};
      if(!CATEGORIES.includes(category))return {state:'rejected',reason:'bad_category',detail:'category one of '+CATEGORIES.join(', ')};
      const at=amountAtomic!==undefined?BigInt(amountAtomic):(()=>{const m=/^\s*(\d{1,9})(?:\.(\d{1,6}))?\s*$/.exec(String(amount??''));if(!m)throw Error('amount like "6.50"');return BigInt(m[1])*1000000n+BigInt((m[2]??'').padEnd(6,'0'));})();
      if(at<=0n)return {state:'rejected',reason:'bad_amount',detail:'amount must be > 0'};
      const cardId='card-'+randomBytes(5).toString('hex');
      const r=await pay({to:provider.fundingAddress,amountAtomic:String(at),merchant:'card:'+merchant,orderRef:cardId,idempotencyKey:'card-'+cardId});
      if(!['paid','settled','confirmed'].includes(r?.state)){return {state:r?.state??'failed',reason:r?.reason??'funding_failed',detail:'the card was not issued because funding did not complete: '+(r?.detail??r?.reason??'unknown'),funding:r};}
      const card=provider.issue({cardId,amountAtomic:at,merchant,category});
      S.cards[cardId]={cardId,merchant,category,note:String(note).slice(0,200),agentId:agentId??null,amountAtomic:String(at),fundingTx:r.txHash??null,purchaseKey:r.purchaseKey??null,createdAt:now(),status:'active',last4:card.last4};save();
      return {state:'issued',card:{cardId,last4:card.last4,panMasked:card.panMasked,expires:card.expires,limit:(Number(at)/1e6).toFixed(2),merchantLock:merchant,category},funding:{txHash:r.txHash??null,purchaseKey:r.purchaseKey??null},
        howToUse:'Single-use card locked to this merchant and amount. Pay at checkout (online card form, or Apple Pay once the issuer supports provisioning). Unused money returns to the wallet.'};},
    authorize(cardId,o){const rec=S.cards[cardId];if(!rec)return {approved:false,reason:'unknown_card'};const a=provider.authorize(cardId,o);
      if(a.approved){rec.status='used';rec.spentAtomic=String(o.amountAtomic);rec.leftoverAtomic=a.leftoverAtomic;rec.usedAt=now();rec.usedAt_merchant=o.merchant;save();}return a;},
    list(){return Object.values(S.cards).sort((a,b)=>b.createdAt-a.createdAt);},
    get(id){return S.cards[id]??null;}};}
