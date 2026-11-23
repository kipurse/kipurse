// SPDX-License-Identifier: Apache-2.0
// Anthropic Messages API tool use: pass `claudeTools` as `tools`, then for each `tool_use` block call `handleClaudeToolUse`.
// (Claude Desktop / Claude Code can also use the MCP server directly: src/v5/mcp-main.mjs.)
import {TOOLS,runTool} from './tools.mjs';
export const claudeTools=TOOLS.map(t=>({name:t.name,description:t.description,input_schema:t.parameters}));
export async function handleClaudeToolUse(kp,block){const out=await runTool(kp,block.name,block.input);return {type:'tool_result',tool_use_id:block.id,content:JSON.stringify(out)};}
