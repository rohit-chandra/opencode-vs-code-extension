#!/usr/bin/env node
// Minimal stdio MCP server (newline-delimited JSON-RPC) for tests. Tools: echo, add.
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo back the given text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name === 'echo') return reply({ content: [{ type: 'text', text: `echo:${args.text}` }] });
      if (name === 'add') return reply({ content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
      return reply({ content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true });
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
