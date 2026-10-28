// Chat with tools, for all three API shapes (Claude, OpenAI-compatible, Gemini). The model may call tools; we run them,
// feed the results back and let it continue, up to maxSteps rounds. Text is streamed to onText as it arrives.
import { baseOf, needsKey, fail, sse } from './providers.js';
import { runTool, describeCall } from './tools.js';

const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
const MEDIA = new Set(['image', 'pdf', 'audio']);

// Does this model accept sound directly? ("" = guess from the name, "yes"/"no" = the user's choice in Settings.)
export function audioCapable(p) {
  if (p.audio === 'yes') return true;
  if (p.audio === 'no') return false;
  const m = String(p.model || '').toLowerCase();
  if (p.provider === 'gemini') return true;
  if (p.provider === 'anthropic') return false;
  return /gemini|audio|omni|gpt-4o-audio|voxtral/.test(m);
}

// Text files go into the message text; pictures, PDFs and sound go in as media. An attachment whose data was not kept
// (older chats) is mentioned by name only.
function split(m) {
  const atts = m.attachments || [];
  let text = m.content || '';
  for (const a of atts) {
    if (a.kind === 'text' && a.text != null) text += `\n\n<file name="${a.name}">\n${a.text}\n</file>`;
    else if (!a.data) text += `\n\n[attached earlier: ${a.name}]`;
  }
  const media = atts.filter((a) => a.data && MEDIA.has(a.kind));
  if (!text.trim() && media.length) text = media.some((a) => a.kind === 'audio') ? 'Please respond to the attached voice message.' : 'Please look at the attached file.';
  return { text: text.trim(), media };
}

const oaHistory = (history, system) => {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of history) {
    const { text, media } = split(m);
    if (m.role === 'user' && media.length) {
      out.push({ role: 'user', content: [{ type: 'text', text }, ...media.map((a) =>
        a.kind === 'image' ? { type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } }
          : a.kind === 'pdf' ? { type: 'file', file: { filename: a.name, file_data: `data:application/pdf;base64,${a.data}` } }
            : { type: 'input_audio', input_audio: { data: a.data, format: /mp3|mpeg/.test(a.mime) ? 'mp3' : 'wav' } })] });
    } else out.push({ role: m.role, content: text });
  }
  return out;
};
const antHistory = (history) => history.map((m) => {
  const { text, media } = split(m);
  const blocks = media.filter((a) => a.kind !== 'audio').map((a) => a.kind === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
  return { role: m.role, content: m.role === 'user' && blocks.length ? [...blocks, { type: 'text', text }] : text };
});
const gemHistory = (history) => history.map((m) => {
  const { text, media } = split(m);
  return { role: m.role === 'assistant' ? 'model' : 'user', parts: [...media.map((a) => ({ inline_data: { mime_type: a.mime, data: a.data } })), { text }] };
});

// Gemini wants upper-case types and rejects some JSON-schema words.
const gemSchema = (s) => {
  if (Array.isArray(s)) return s.map(gemSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties' || k === 'default' || (k === 'required' && Array.isArray(v) && !v.length)) continue;
    o[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : gemSchema(v);
  }
  return o;
};
const parseArgs = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

async function exec(o, id, name, args) {
  const ev = { id, name, args };
  o.onTool?.({ ...ev, status: 'start', summary: describeCall(name, args) });
  try {
    const r = await runTool(name, args, o.ctx);
    o.onTool?.({ ...ev, status: 'done', summary: r.summary });
    return r.text;
  } catch (e) {
    const msg = String(e.message || e);
    o.onTool?.({ ...ev, status: 'error', summary: msg });
    return 'Error: ' + msg;
  }
}
const looksLikeNoTools = (t) => /tool|function.?call|function_call/i.test(t);

// ---------- OpenAI and everything that speaks its format ----------
async function loopOpenAI(o) {
  const { p, tools, signal } = o, base = baseOf(p), temp = num(p.temperature);
  const msgs = oaHistory(o.history, o.system);
  let useTools = tools.length > 0;
  for (let step = 0; step < o.maxSteps; step++) {
    const body = { model: p.model, messages: msgs, stream: true };
    if (temp != null) body.temperature = temp;
    if (useTools) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.params } }));
    const headers = { 'content-type': 'application/json' };
    if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
    const res = await fetch(base + '/chat/completions', { method: 'POST', signal, headers, body: JSON.stringify(body) });
    if (!res.ok) {
      if (useTools && step === 0 && res.status >= 400 && res.status < 500 && looksLikeNoTools(await res.clone().text().catch(() => ''))) {
        useTools = false; o.onNotice?.('This model does not support tools, so it will answer without them.'); step--; continue;
      }
      await fail(res);
    }
    let text = ''; const calls = [];
    for await (const d of sse(res)) {
      if (d === '[DONE]') break;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'Stream error');
      const dl = j.choices?.[0]?.delta; if (!dl) continue;
      if (dl.content) { text += dl.content; o.onText(dl.content); }
      for (const tc of dl.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name && !c.name) c.name = tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
    const list = calls.filter((c) => c && c.name);
    if (!list.length) return;
    list.forEach((c, i) => { if (!c.id) c.id = 'call_' + step + '_' + i; });
    msgs.push({ role: 'assistant', content: text || null, tool_calls: list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    for (const c of list) msgs.push({ role: 'tool', tool_call_id: c.id, content: await exec(o, c.id, c.name, parseArgs(c.args)) });
  }
  o.onText('\n\n(Stopped: too many tool rounds in a row.)');
}

// ---------- Claude ----------
async function loopAnthropic(o) {
  const { p, tools, signal } = o, base = baseOf(p), temp = num(p.temperature);
  const msgs = antHistory(o.history);
  for (let step = 0; step < o.maxSteps; step++) {
    const body = { model: p.model, max_tokens: num(p.maxTokens) || 4096, messages: msgs, stream: true };
    if (o.system) body.system = o.system;
    if (temp != null) body.temperature = temp;
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.desc, input_schema: t.params }));
    const res = await fetch(base + '/v1/messages', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) });
    if (!res.ok) await fail(res);
    const blocks = [];
    for await (const d of sse(res)) {
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.type === 'content_block_start') blocks[j.index] = { type: j.content_block.type, text: j.content_block.text || '', id: j.content_block.id, name: j.content_block.name, json: '' };
      else if (j.type === 'content_block_delta') {
        const b = blocks[j.index]; if (!b) continue;
        if (j.delta.type === 'text_delta') { b.text += j.delta.text; o.onText(j.delta.text); }
        else if (j.delta.type === 'input_json_delta') b.json += j.delta.partial_json || '';
      } else if (j.type === 'error') throw new Error(j.error?.message || 'Stream error');
    }
    const used = blocks.filter((b) => b && b.type === 'tool_use');
    if (!used.length) return;
    msgs.push({ role: 'assistant', content: blocks.filter((b) => b && (b.type === 'tool_use' || (b.type === 'text' && b.text))).map((b) => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: parseArgs(b.json) }) });
    const results = [];
    for (const b of used) results.push({ type: 'tool_result', tool_use_id: b.id, content: await exec(o, b.id, b.name, parseArgs(b.json)) });
    msgs.push({ role: 'user', content: results });
  }
  o.onText('\n\n(Stopped: too many tool rounds in a row.)');
}

// ---------- Gemini ----------
async function loopGemini(o) {
  const { p, tools, signal } = o, base = baseOf(p), temp = num(p.temperature);
  const contents = gemHistory(o.history), model = p.model.replace(/^models\//, '');
  for (let step = 0; step < o.maxSteps; step++) {
    const body = { contents };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    if (tools.length) body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.desc, parameters: gemSchema(t.params) })) }];
    const gc = {}; if (temp != null) gc.temperature = temp; if (num(p.maxTokens)) gc.maxOutputTokens = num(p.maxTokens);
    if (Object.keys(gc).length) body.generationConfig = gc;
    const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey }, body: JSON.stringify(body) });
    if (!res.ok) await fail(res);
    const parts = [];
    for await (const d of sse(res)) {
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'Stream error');
      if (j.promptFeedback?.blockReason) throw new Error('Blocked by Gemini: ' + j.promptFeedback.blockReason);
      for (const part of j.candidates?.[0]?.content?.parts || []) {
        if (part.thought) continue;
        if (part.text) o.onText(part.text);
        parts.push(part);
      }
    }
    const calls = parts.filter((x) => x.functionCall);
    if (!calls.length) return;
    contents.push({ role: 'model', parts });
    const answers = [];
    for (const [i, x] of calls.entries()) {
      const c = x.functionCall, out = await exec(o, c.id || 'g' + step + '_' + i, c.name, c.args || {});
      answers.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: { result: out } } });
    }
    contents.push({ role: 'user', parts: answers });
  }
  o.onText('\n\n(Stopped: too many tool rounds in a row.)');
}

// o: { p, history:[{role,content,attachments?}], system, tools:[tool], signal, ctx, onText(chunk), onTool(event), onNotice(text), maxSteps }
export async function runAgent(o) {
  const { p } = o;
  if (!p.model) throw new Error('Type a model name in Settings first.');
  if (!baseOf(p)) throw new Error('This profile needs a base URL.');
  if (needsKey(p) && !p.apiKey) throw new Error('Add your API key in Settings first.');
  o = { maxSteps: 8, tools: [], ...o };
  if (p.provider === 'anthropic') return loopAnthropic(o);
  if (p.provider === 'gemini') return loopGemini(o);
  return loopOpenAI(o);
}
