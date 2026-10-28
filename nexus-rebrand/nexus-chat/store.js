// Settings and built-in site list shared by the panel and the background worker.

export const SITES = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', domains: ['chatgpt.com', 'openai.com'], note: 'ChatGPT does not allow itself to be shown inside other pages, so it opens in its own window. Basic chat works without an account.', enabled: true, embed: false },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', domains: ['gemini.google.com', 'accounts.google.com'], note: 'Google does not allow sign-in inside other pages, so Gemini opens in its own window.', enabled: true, embed: false },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', domains: ['claude.ai'], note: 'Claude does not allow itself to be shown inside other pages, so it opens in its own window.', enabled: true, embed: false },
  { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com/', domains: ['copilot.microsoft.com', 'login.live.com', 'login.microsoftonline.com'], note: 'Works without an account.', enabled: true },
  { id: 'duckai', name: 'DuckDuckGo AI', url: 'https://duckduckgo.com/aichat', domains: ['duckduckgo.com', 'duck.ai'], note: 'No account needed.', enabled: true },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', domains: ['perplexity.ai'], note: 'Basic search works without an account.', enabled: false },
  { id: 'mistral', name: 'Le Chat', url: 'https://chat.mistral.ai/chat', domains: ['mistral.ai'], note: 'Sign in with a Mistral account.', enabled: false },
].map((s) => ({ ...s, builtin: true }));

export const DEFAULT_PROMPT = 'You are Nexus, a helpful assistant built into the Nexus browser. Be clear and concise. Use Markdown when it helps. If you are unsure, say so.';

export const newProfile = (p = {}) => ({
  id: 'p' + Math.random().toString(36).slice(2, 9), name: 'New profile', provider: 'anthropic',
  apiKey: '', model: '', baseUrl: '', temperature: '', maxTokens: 4096, ...p,
});

// The floating "Ask Nexus" button shown on web pages (like Chrome's Ask Gemini button).
// enabled: the page pill is OFF by default (the toolbar crosshair icon opens the panel). Turn it on in settings or from the toolbar icon's right-click menu.
// mode: 'docked' (default: sits flush against the top or bottom edge of the page, like a tab) | 'floating' (free round button).
// dock: tr | tl | br | bl  = where the docked pill sits.   corner/offsetX/offsetY are used by the floating mode.
export const LAUNCHER = { enabled: false, mode: 'docked', dock: 'tr', corner: 'tr', offsetX: 14, offsetY: 14, size: 'm', label: true, idle: 0.85, hiddenOn: [] };

export const DEFAULTS = {
  signinBridge: false,           // carry sign-ins made in a normal window into the panel (off until you allow it)
  googleAccount: '',             // optional: which Google account Gemini should open with
  panelEnabled: true,            // master switch for the whole AI side panel (default on)
  launcher: LAUNCHER,
  active: 'p1',
  profiles: [newProfile({ id: 'p1', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5-5' })],
  systemPrompt: DEFAULT_PROMPT,
  pageContext: false,
  enterToSend: true,
  fontSize: 14,
  theme: 'auto',
  lastTab: 'api',
  tools: { enabled: true, off: [] },   // what the model may call (search, clock, ...)
  translateTo: 'English',
  sites: SITES,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...structuredClone(DEFAULTS), ...(settings || {}) };
  s.launcher = { ...LAUNCHER, ...((settings && settings.launcher) || {}) };
  s.tools = { ...DEFAULTS.tools, ...((settings && settings.tools) || {}) };
  const have = new Set((s.sites || []).map((x) => x.id));
  for (const b of SITES) if (!have.has(b.id)) s.sites.push({ ...b });
  // Sites saved by an older version get the built-in text and the built-in embed choice (unless you changed it yourself).
  for (const x of s.sites) { const b = SITES.find((y) => y.id === x.id); if (b) { x.note = b.note; if (x.embed === undefined) x.embed = b.embed; } }
  if (!s.profiles.length) s.profiles = structuredClone(DEFAULTS.profiles);
  if (!s.profiles.some((p) => p.id === s.active)) s.active = s.profiles[0].id;
  return s;
}
export const saveSettings = (s) => chrome.storage.local.set({ settings: s });

export const hostnameOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
export const domainsFor = (site) => (site.builtin ? site.domains : [hostnameOf(site.url)]).filter(Boolean);
