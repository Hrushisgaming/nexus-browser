NEXUS AUTHENTICATOR - 2-step verification codes for Nexus, compatible with Google Authenticator

BUILT IN
It comes with Nexus.app and is pinned to the toolbar. There is nothing to install. (In a build made from the Nexus source it is compiled
into the browser, like uBlock Origin; see NATIVE_VAULT_VPN.md. The same folder also loads as a normal Chrome extension.)

MOVE YOUR ACCOUNTS OVER FROM GOOGLE AUTHENTICATOR
1. On your phone: Google Authenticator > menu > Transfer accounts > Export accounts. A QR code appears.
2. In Nexus: open this extension > Add > Scan screen > Select area on page, and drag a box around that QR code.
   (Or screenshot it and use Add > Image.) Each QR holds a batch of accounts; if it says "batch 1 of 2", repeat for the next.

SEND ACCOUNTS BACK TO GOOGLE AUTHENTICATOR
Export > choose accounts > Show transfer QR codes. On the phone: Google Authenticator > menu > Transfer accounts > Import accounts.
The "QR" button next to one account makes a normal single-account QR code that works in any authenticator app.

ADDING ACCOUNTS
- Scan screen: drag a box around a QR on the page you are viewing (shortcut Alt+Shift+Q), or scan the whole visible page.
- Image: drop, choose or paste (Cmd+V) a screenshot or photo of a QR code.
- Link / key: paste otpauth:// links, a Google transfer link, or a plain setup key.
- Manual: service, account and key.

SECURITY NOTES
- Accounts are encrypted with AES-256-GCM; the key comes from your master password (PBKDF2-SHA256, 600,000 rounds). It cannot be recovered.
- While unlocked, the key is kept in the browser's memory-only session storage until auto-lock (default 5 minutes) or until you quit.
- QR codes that show secret keys ask for your password first and hide after 60 seconds.
- The extension has no network access and no host permissions (only storage, activeTab, scripting, alarms).
- Back up: Export > Download backup (encrypted with a password you choose).
- Not independently audited. Keep recovery codes for important accounts (email, banking) somewhere safe as well.

LIMITS
- Screen scanning works on normal web pages; browser pages (settings, new tab, web store) can't be captured. Use Add > Image there.
- Only time-based (TOTP) codes. Counter-based (HOTP) accounts are skipped.
- Google Authenticator assumes 30-second codes, so accounts with another period won't match after a transfer (the export screen warns you).
- Third-party code: jsQR (Apache-2.0) and qrcode-generator (MIT), see vendor/LICENSES.txt.
