// SPDX-License-Identifier: Apache-2.0
// LangChain.js: `kipurseLangChainTools(kp, tool)` where `tool` is imported from '@langchain/core/tools'.
import {TOOLS,runTool} from './tools.mjs';
export const kipurseLangChainTools=(kp,tool)=>TOOLS.map(t=>tool(async a=>JSON.stringify(await runTool(kp,t.name,a)),{name:t.name,description:t.description,schema:t.parameters}));
