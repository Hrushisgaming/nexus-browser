// Talks to AI provider APIs directly from the browser. Keys are only ever sent to the endpoint you configure.

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', base: 'https://api.anthropic.com', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-5'] },
  openai: { label: 'OpenAI (ChatGPT)', base: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
  gemini: { label: 'Google (Gemini)', base: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  compatible: { label: 'Other OpenAI-compatible service (type the address)', base: '', models: [] },
};

// [name, base URL, example model]. The model is only filled in when the profile has none yet. Models change often:
// press "Find models" in Settings to list what your key can really use.
export const PRESETS = [
  ['NVIDIA (build.nvidia.com)', 'https://integrate.api.nvidia.com/v1', 'meta/llama-3.3-70b-instruct'],
  ['OpenRouter', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini'],
  ['Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
  ['Cerebras', 'https://api.cerebras.ai/v1', ''],
  ['SambaNova', 'https://api.sambanova.ai/v1', ''],
  ['Fireworks', 'https://api.fireworks.ai/inference/v1', ''],
  ['DeepInfra', 'https://api.deepinfra.com/v1/openai', ''],
  ['Hyperbolic', 'https://api.hyperbolic.xyz/v1', ''],
  ['Together', 'https://api.together.xyz/v1', ''],
  ['Mistral', 'https://api.mistral.ai/v1', 'mistral-large-latest'],
  ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['xAI (Grok)', 'https://api.x.ai/v1', ''],
  ['Perplexity', 'https://api.perplexity.ai', 'sonar'],
  ['Moonshot (Kimi)', 'https://api.moonshot.ai/v1', ''],
  ['Z.ai (GLM)', 'https://api.z.ai/api/paas/v4', ''],
  ['GitHub Models', 'https://models.github.ai/inference', ''],
  ['Ollama (this computer)', 'http://localhost:11434/v1', ''],
  ['LM Studio (this computer)', 'http://localhost:1234/v1', ''],
];

export const needsKey = (p) => p.provider !== 'compatible';
export const baseOf = (p) => (p.baseUrl || PROVIDERS[p.provider].base || '').replace(/\/+$/, '');

async function fail(res) {
  let msg = '';
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); msg = j.error?.message || j.error || j.message || (Array.isArray(j) && j[0]?.error?.message) || t; } catch { msg = t; }
  } catch { /* ignore */ }
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  throw new Error(`${res.status} ${res.statusText || ''}${msg ? ': ' + msg.slice(0, 400) : ''}`.trim());
}

// Yields the payload of each server-sent event.
async function* sse(res) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let m; (m = /\r?\n\r?\n/.exec(buf));) {
      const block = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield data;
    }
  }
  const tail = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  if (tail) yield tail;
}

const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);

// messages: [{role:'user'|'assistant', content}]. Yields text chunks.
export async function* streamChat(p, messages, system, signal) {
  if (!p.model) throw new Error('Type a model name in Settings first.');
  const base = baseOf(p), temp = num(p.temperature);
  if (!base) throw new Error('This profile needs a base URL.');
  if (needsKey(p) && !p.apiKey) throw new Error('Add your API key in Settings first.');

  if (p.provider === 'anthropic') {
    const body = { model: p.model, max_tokens: num(p.maxTokens) || 4096, messages, stream: true };
    if (system) body.system = system;
    if (temp != null) body.temperature = temp;
    const res = await fetch(base + '/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res);
    for await (const d of sse(res)) {
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield j.delta.text;
      else if (j.type === 'error') throw new Error(j.error?.message || 'Stream error');
    }
  } else if (p.provider === 'gemini') {
    const body = { contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const gc = {}; if (temp != null) gc.temperature = temp; if (num(p.maxTokens)) gc.maxOutputTokens = num(p.maxTokens);
    if (Object.keys(gc).length) body.generationConfig = gc;
    const model = p.model.replace(/^models\//, '');
    const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey }, body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res);
    for await (const d of sse(res)) {
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'Stream error');
      for (const part of j.candidates?.[0]?.content?.parts || []) if (part.text && !part.thought) yield part.text;
      if (j.promptFeedback?.blockReason) throw new Error('Blocked by Gemini: ' + j.promptFeedback.blockReason);
    }
  } else {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const body = { model: p.model, messages: msgs, stream: true };
    if (temp != null) body.temperature = temp;
    const headers = { 'content-type': 'application/json' };
    if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
    const res = await fetch(base + '/chat/completions', { method: 'POST', signal, headers, body: JSON.stringify(body) });
    if (!res.ok) await fail(res);
    for await (const d of sse(res)) {
      if (d === '[DONE]') break;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'Stream error');
      const t = j.choices?.[0]?.delta?.content;
      if (t) yield t;
    }
  }
}

export async function listModels(p) {
  const base = baseOf(p);
  if (!base) throw new Error('Set the base URL first.');
  let res, pick;
  if (p.provider === 'anthropic') {
    res = await fetch(base + '/v1/models?limit=100', { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    pick = (j) => j.data.map((m) => m.id);
  } else if (p.provider === 'gemini') {
    res = await fetch(base + '/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': p.apiKey } });
    pick = (j) => j.models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  } else {
    res = await fetch(base + '/models', { headers: p.apiKey ? { authorization: 'Bearer ' + p.apiKey } : {} });
    pick = (j) => (j.data || j.models || []).map((m) => m.id || m.name);
  }
  if (!res.ok) await fail(res);
  return pick(await res.json()).filter(Boolean).sort();
}
