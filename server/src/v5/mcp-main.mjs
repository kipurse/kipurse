import {applyOwnerRulesConfig} from './owner-wiring.mjs';import {ownerRulesIsValid} from './owner-wiring-chain.mjs';
// SPDX-License-Identifier: AGPL-3.0-only
// V5 MCP stdio entry (testnet only in this milestone; mainnet V5 needs the owner migration first).
//   V5_CONFIG=<v5-config.json> V5_KEYS=<testnet keys file, 0600, loaded here and never printed> V5_LEDGER=<sqlite> AGENT_ID=<name> node src/v5/mcp-main.mjs
import fs from 'node:fs';import {createEngineV5} from './engine.mjs';import {applyMerchantAuthConfig} from './merchant-auth.mjs';import {createV5Mcp} from './mcp.mjs';import {resolveAgent} from '../v4/agents.mjs';
const cfg=JSON.parse(fs.readFileSync(process.env.V5_CONFIG));if(cfg.chainId!==84532)throw Error('V5 gateway mode is testnet-only until the owner migrates mainnet');
let agentId=process.env.AGENT_ID??'mcp-agent';
if(cfg.agents){const a=resolveAgent(cfg.agents,process.env.AGENT_TOKEN);if(!a)throw Error('AGENT_TOKEN invalid or missing');agentId=a.id;}
if((fs.statSync(process.env.V5_KEYS).mode&0o777)!==0o600)throw Error('keys must be 0600');
cfg.executorKey=JSON.parse(fs.readFileSync(process.env.V5_KEYS)).executor;applyMerchantAuthConfig(cfg);await applyOwnerRulesConfig(cfg,{isValid:()=>ownerRulesIsValid(cfg)});
await createV5Mcp(createEngineV5(cfg,{ledgerFile:process.env.V5_LEDGER??cfg.ledgerFile,agentDefault:agentId}),{agentId}).start();
