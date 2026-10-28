CHAT WITH NEXUS - the AI side panel built into Nexus

It comes with the app: there is nothing to install. It loads every time Nexus starts.
(The old "Load unpacked" steps are no longer needed. If you installed it that way before, remove that copy at helium://extensions.)

OPEN IT
- Click the round "Ask Nexus" button in the corner of any web page (top right by default), or
- click the Chat with Nexus icon in the toolbar, or press Alt+Shift+N.

SETTINGS (side panel > Settings, or right-click the button > Customize)
- "Turn on the AI side panel": the master switch, on by default. Off hides the button, the right-click entries and the panel.
- The page button ("Ask Nexus" pill): show/hide, style, position, size, words next to the icon, sites to hide it on.
  The pill is OFF by default (the crosshair in the toolbar opens the panel). Turn it on in settings or from the toolbar icon's right-click menu.
  Style "Docked" (the default once it is on) puts the pill flush against the top or bottom edge of the page, like a tab. "Floating" is the old round button.
  Drag it to the top or bottom edge to move it; docked, it snaps to Top/Bottom, Left/Right. With vertical tabs pick Bottom left.
  Quick switch: right-click the Chat with Nexus toolbar icon > "Show the Ask Nexus pill on pages" (and the docked / floating choice).
  The pill is part of the web page, so it cannot live inside the browser's own tab bar (that is native browser code).

TWO WAYS TO CHAT
A) Sign-in sites: the tabs at the top (ChatGPT, Gemini, Claude, Copilot, DuckDuckGo AI, and any you add) open the real site inside the panel.
   If one will not load or sign in, press "Open in window".
B) Nexus AI tab (your own API key): Settings > AI connection. Pick Claude, ChatGPT/OpenAI, Gemini, or any OpenAI-compatible service
   (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Ollama, LM Studio). Paste your key and type any model name.

PICK A MODEL
- At the bottom of the Nexus AI tab there is a model dropdown (and a profile dropdown if you saved more than one connection).
  Choose a model, or "Find all models..." to list everything your key can use, or "Other..." to type any name.
- The ChatGPT / Gemini / Claude tabs are the real sites, so pick the model inside the site itself.

SIGNING IN (side panel tabs)
- Press "Sign in" in the strip under a site tab. It opens the real login in a small window (Google and "Continue with Google" refuse to run inside the panel itself).
  When you close that window, the panel reloads the site. The first time it asks to turn on "Keep sign-ins working inside the panel" (Settings > Accounts).
- One Google account does not sign you into everything at once: do "Continue with Google" once on ChatGPT and once on Claude. Gemini simply uses your Google account.
- Settings > Accounts > Google account: type your Gmail so Gemini opens with that account when several are signed in.
- If a site still shows you signed out in the panel, press "Dock": it opens the site in a real window on the right and shrinks the browser to make room.

HANDY THINGS
- The empty chat screen greets you with a random casual line each time you start a new chat.
- "Use this page" sends the current page's text with your message.
- Right-click selected text > "Ask Nexus about ...", or right-click a page > "Chat with Nexus about this page".
- Ollama / LM Studio on this computer: use the base URL shown in the preset list. No key needed.
  If Ollama still refuses, start it with  OLLAMA_ORIGINS="chrome-extension://*".

PRIVACY AND SECURITY
- No analytics, no servers of ours. Your key is sent only to the provider you pick. Chats and settings stay in this browser profile.
- API keys are stored in the browser profile in plain text (like most extensions). Do not share the exported settings file.
- The page button never reads the page. It only opens the panel.
- To make the sign-in sites work inside the panel, the extension removes their "do not embed me" headers (X-Frame-Options and
  Content-Security-Policy), only for the sites you enabled and only inside this panel. Turn off any site you do not use.

NEW IN 1.6  (attachments, tools, voice, translate, full tab)
- Attach files: paperclip button, drag and drop, or paste a picture. Pictures, PDFs, text/code files and audio work (the model must support what you attach).
- Tools: the model can search the web, read pages, tell the time, calculate, check weather, look up Wikipedia, read your current page or tab list,
  make downloadable files, keep notes and more. Each use shows as "Model called search", "Model called clock" and so on. Turn tools off or pick them in Settings > Tools.
  If a model does not support tools it just answers without them.
- Voice: microphone button. Models that can hear (Gemini, GPT audio models...) get your voice directly. Other models need an OpenAI or Groq profile to turn voice into text.
  Settings > AI connection > Advanced > "Can this model hear audio?" overrides the guess. (On-device Moonshine is not included yet.)
- Translate page: button under the chat. Translates the page you are on, in place, with your AI model. Press again to show the original. Language: Settings > Translate.
- Full tab: the window icon in the panel header, or type nexus://ai. Same chat, whole tab.
