// SPDX-License-Identifier: Apache-2.0
// OpenAI Agents SDK (@openai/agents): `new Agent({tools: kipurseOpenAITools(kp, tool)})` where `tool` is imported from '@openai/agents'.
import {TOOLS,runTool} from './tools.mjs';
export const kipurseOpenAITools=(kp,tool)=>TOOLS.map(t=>tool({name:t.name,description:t.description,parameters:t.parameters,strict:false,execute:a=>runTool(kp,t.name,a)}));
