Nexus Core Connect: pairs this browser with Nexus Core (the desktop app) using a code, then lets Nexus open, read and drive tabs.
Source of truth: github.com/hrushisgaming/nexus-core/tree/main/browser-extension (copied here at build time of this tree; re-copy to update).
Built into the browser like Nexus Vault / Authenticator (see helium-macos/patches/nexus/builtin-vault-vpn.patch). Fixed id by the "key" in manifest.json: lcjcplddeeeaemcmkkijilbhnmlbdnam
Safety (all enforced inside the extension): own "Nexus" tab group, block/allow site list, confirmation for payments/sends/deletes/uploads, pause (Alt+Shift+P), activity log.
