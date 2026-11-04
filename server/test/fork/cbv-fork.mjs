// t796: KYC-on reality for fork tests. Plants a REAL-shaped Coinbase Verified Account attestation on the throwaway fork (impersonating
// Coinbase's attester through anvil, then indexing it), so the gateway's normal CBV check (KIPURSE_CBV_RPCS = the fork) says verified.
import {createTestClient,createWalletClient,createPublicClient,http,parseAbi,encodeAbiParameters,decodeEventLog,getAddress} from 'viem';import {base} from 'viem/chains';
import {CBV} from '../../src/v5/cb-verified.mjs';
const EAS=parseAbi(['function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)','event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)']);
const IDX=parseAbi(['function indexAttestation(bytes32 attestationUID)']);
export async function plantCbv(rpc,recipient){const tc=createTestClient({chain:base,mode:'anvil',transport:http(rpc)}),pub=createPublicClient({chain:base,transport:http(rpc)});
  const at=getAddress(CBV.attester);await tc.impersonateAccount({address:at});await tc.setBalance({address:at,value:10n**18n});const w=createWalletClient({chain:base,account:at,transport:http(rpc)});
  const h=await w.writeContract({address:CBV.eas,abi:EAS,functionName:'attest',args:[{schema:CBV.schema,data:{recipient:getAddress(recipient),expirationTime:0n,revocable:true,refUID:'0x'+'0'.repeat(64),data:encodeAbiParameters([{type:'bool'}],[true]),value:0n}}]});
  const r=await pub.waitForTransactionReceipt({hash:h});if(r.status!=='success')throw Error('cbv attest failed');
  const uid=r.logs.map(l=>{try{return decodeEventLog({abi:EAS,data:l.data,topics:l.topics});}catch{return null;}}).find(e=>e?.eventName==='Attested').args.uid;
  const h2=await w.writeContract({address:CBV.indexer,abi:IDX,functionName:'indexAttestation',args:[uid]});await pub.waitForTransactionReceipt({hash:h2});await tc.stopImpersonatingAccount({address:at});return uid;}
