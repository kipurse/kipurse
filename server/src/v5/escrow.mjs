// DELIVERY-CONFIRMED ESCROW (t595 item 3) - TESTNET / FORK ONLY until the owner approves a mainnet deploy.
// The AI pays INTO the owner's KipurseEscrowV1 through the normal pay entry (gated on the MERCHANT: single limit, new-payee
// Face ID, scam + sanctions; 0.1% fee charged once by the adapter; gas at actual cost), then the gateway opens the order.
// Release: merchant confirms fulfillment (+ review window) or the owner confirms. Refund: timeout (anyone) or owner cancel.
import {keccak256,toHex,getAddress,parseAbi,encodeFunctionData} from 'viem';
export const ESCROW_ABI=parseAbi(['function open(bytes32 id,address merchant,uint96 amount,uint64 deadline,uint32 reviewSec)','function confirmFulfilled(bytes32 id,bytes merchantSig)',
  'function release(bytes32 id)','function ownerConfirm(bytes32 id)','function ownerCancel(bytes32 id)','function refundExpired(bytes32 id)','function sweepUnallocated()',
  'function orders(bytes32) view returns (address merchant,uint96 amount,uint64 deadline,uint64 fulfilledAt,uint32 reviewSec,uint8 state)','function unallocated() view returns (uint256)',
  'function fulfilledDigest(bytes32 id) view returns (bytes32)','function owner() view returns (address)']);
const WALLET_EXEC=parseAbi(['function execute(address target,uint256 value,bytes data)']);
const STATE=['none','open','fulfilled','released','refunded'];
export const escrowId=k=>keccak256(toHex('kipurse-escrow:'+String(k)));
export function createEscrow({buy,pub,write,address,defaults={deadlineSec:3*86400,reviewSec:86400}}){const A=getAddress(address);
  const rd=(fn,args=[])=>pub.readContract({address:A,abi:ESCROW_ABI,functionName:fn,args});
  async function status(id){const o=await rd('orders',[id]);const now=Number((await pub.getBlock()).timestamp);
    return {id,merchant:o[0],amount:o[1].toString(),deadline:Number(o[2]),fulfilledAt:Number(o[3]),reviewSec:Number(o[4]),state:STATE[o[5]]??'unknown',
      releasableAt:o[5]===2?Number(o[3])+Number(o[4]):null,refundableAfter:o[5]===1?Number(o[2]):null,now};}
  async function pay({merchant,amount,item,merchantName,idempotencyKey,deadlineSec=defaults.deadlineSec,reviewSec=defaults.reviewSec,user_request},agentId){
    if(!(deadlineSec>=3600&&deadlineSec<=90*86400))return {state:'rejected',reason:'escrow_deadline_1h_to_90d',nothingPaid:true};
    if(!(reviewSec>=0&&reviewSec<=7*86400))return {state:'rejected',reason:'escrow_review_max_7d',nothingPaid:true};
    const id=escrowId(idempotencyKey);const st=await status(id);if(st.state!=='none')return {state:'already_open',escrow:st};
    const r=await buy.buy({to:A,amount,merchant:merchantName??'escrow',item,user_request,escrowFor:merchant,idempotencyKey},agentId);
    // resume after a crash between 'paid in' and 'open': the deposit is already on chain, open it now (funds are still unallocated)
    if(!['paid','already_paid_on_chain','already_paid'].includes(r.state))return r;
    const atomic=BigInt(Math.round(Number(amount)*1e6));const deadline=(await pub.getBlock()).timestamp+BigInt(deadlineSec); // chain time
    const tx=await write('open',[id,getAddress(merchant),atomic,deadline,reviewSec]);
    const who=merchantName??'商家';
    return {...r,escrow:{...(await status(id)),openTx:tx},say_to_user:`已付 ${amount} USDC 进托管，${who}确认发货/交付后才会放款；${Math.round(deadlineSec/86400*10)/10} 天内没交付会自动退回给你，你也可以随时取消。 / Paid ${amount} USDC into escrow: released to ${merchantName??'the merchant'} only after fulfillment; refunded to you automatically if not delivered in time; you can cancel.`};}
  return {status,pay,
    confirmFulfilled:(id,sig='0x')=>write('confirmFulfilled',[id,sig]),release:id=>write('release',[id]),refundExpired:id=>write('refundExpired',[id]),sweep:()=>write('sweepUnallocated',[]),
    fulfilledDigest:id=>rd('fulfilledDigest',[id]),
    /** owner actions are signed by the owner (Face ID) as wallet.execute(escrow, 0, data); the gateway never holds that key */
    ownerCall:(wallet,fn,id)=>({to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:WALLET_EXEC,functionName:'execute',args:[A,0n,encodeFunctionData({abi:ESCROW_ABI,functionName:fn,args:[id]})]})})};
}
