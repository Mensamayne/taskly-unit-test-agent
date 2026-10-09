import { createServer } from 'node:http';

/**
 * A scripted stand-in for the Anthropic Messages API, used to run the real Claude Agent SDK
 * (and the Claude Code process it starts) end to end without a model or a key.
 *
 * `respond(body)` returns the assistant content blocks for one request: text blocks
 * `{ type: 'text', text }` and tool calls `{ type: 'tool_use', name, input }`.
 * Every request body is kept in `requests` for assertions.
 */
export function startFakeAnthropic(respond) {
  const requests = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      n += 1;
      const blocks = respond(body).map((b, i) => (b.type === 'tool_use' ? { id: `toolu_fake_${n}_${i}`, ...b } : b));
      const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      const message = {
        id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-5-5',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 },
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...message, content: blocks, stop_reason: stopReason }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', { message });
      blocks.forEach((block, index) => {
        if (block.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        } else {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
        }
        send('content_block_stop', { index });
      });
      send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Text of every tool_result in a request, keyed by the tool name of the matching tool_use. */
export function toolResults(body) {
  const names = new Map();
  const out = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
      if (block.type === 'tool_result') {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join('\n') : String(block.content ?? '');
        out.push({ name: names.get(block.tool_use_id), isError: Boolean(block.is_error), text });
      }
    }
  }
  return out;
}

/** Number of assistant turns already in the conversation. */
export function assistantTurns(body) {
  return (body.messages ?? []).filter((m) => m.role === 'assistant').length;
}

/** All text the request carries (system and messages), for searching. */
export function requestText(body) {
  return JSON.stringify([body.system ?? '', body.messages ?? []]);
}
