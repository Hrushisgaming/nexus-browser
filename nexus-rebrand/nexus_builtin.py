#!/usr/bin/env python3
"""Make Chat with Nexus, Nexus Authenticator and Proton VPN part of Nexus.app (stdlib only).
usage: nexus_builtin.py /path/to/Nexus.app [--crx vendor/proton-vpn.crx] [--native]

  --native   the app was built from the Nexus source (helium-macos/patches/nexus/builtin-vault-vpn.patch), so Nexus Vault,
             Nexus Authenticator and Proton VPN are already inside the browser like uBlock Origin. Then only Chat with Nexus is added here.

What it does, all inside the app bundle (run it BEFORE re-signing):
  1. copies nexus-chat/, nexus-vault/ and nexus-authenticator/ into Contents/Resources/nexus-extensions/
  2. unpacks the Proton VPN .crx into  .../nexus-extensions/proton-vpn  (keeps its real Web Store id)
  3. swaps the app's start-up program for a small launcher that starts the real browser with
     --load-extension=<each folder above>, and pins their toolbar icons on a brand-new profile
Helium itself ships uBlock Origin compiled into the browser; this is the closest equivalent that needs no compiling.
"""
import base64, hashlib, json, os, plistlib, shutil, stat, struct, sys, zipfile, io

HERE = os.path.dirname(os.path.abspath(__file__))
PROTON_ID = 'jplgfhpmjnbigmhklmmbgecoobifkmpa'
VAULT_ID = 'aideengppkjlkhmlfabkigdahhogfbdi'
CORE_CONNECT_ID = 'lcjcplddeeeaemcmkkijilbhnmlbdnam'   # from the key in nexus-core-connect/manifest.json
AUTHENTICATOR_ID = 'akbamahfimlndcjkkonndelmldbnmefd'    # from the key in nexus-authenticator/manifest.json
UBLOCK_ID = 'blockjmkbacgjkknlgpkjjiijinjdanf'      # Helium pins uBlock by default; a pins list we write must keep it

LAUNCHER = r'''#!/bin/bash
# Nexus launcher: starts the real browser with its own data folder and Nexus's built-in extensions.
# NEXUS_NO_BUILTIN=1 starts without the built-in extensions (for troubleshooting).
# NEXUS_DATA_DIR=/some/folder uses a different data folder.
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="$(cd "$HERE/../Resources/nexus-extensions" 2>/dev/null && pwd)"
DATA="${NEXUS_DATA_DIR:-$HOME/Library/Application Support/Nexus}"
OLD="$HOME/Library/Application Support/net.imput.helium"
# Brand-new profile: copy the bookmarks over from Helium once (they are not encrypted; saved passwords and
# sign-ins cannot be copied because they are locked with Helium's own Keychain key).
if [ ! -f "$DATA/Default/Preferences" ]; then
  mkdir -p "$DATA/Default"
  [ -f "$OLD/Default/Bookmarks" ] && cp -n "$OLD/Default/Bookmarks" "$DATA/Default/Bookmarks" 2>/dev/null
  prefs=""
  if [ -z "$NEXUS_NO_BUILTIN" ] && [ -f "$EXT_ROOT/pins.txt" ]; then   # pin the built-in extensions' toolbar icons
    pins="$(sed 's/.*/"&"/' "$EXT_ROOT/pins.txt" | paste -sd, -)"
    prefs="\"extensions\":{\"pinned_extensions\":[$pins]}"
  fi
  BG="$HERE/../Resources/nexus-default-background.jpg"                 # default new-tab wallpaper (you can change it any time with the pencil on the new tab page)
  if [ -f "$BG" ] && [ ! -f "$DATA/Default/background.jpg" ]; then
    cp "$BG" "$DATA/Default/background.jpg"
    prefs="${prefs:+$prefs,}\"ntp\":{\"custom_background_dict\":{\"background_url\":\"chrome-untrusted://new-tab-page/background.jpg?ts=1\"},\"custom_background_local_to_device\":true}"
  fi
  [ -n "$prefs" ] && printf '{%s}' "$prefs" > "$DATA/Default/Preferences"
fi
list=""
if [ -z "$NEXUS_NO_BUILTIN" ]; then
  for d in "$EXT_ROOT"/*/; do
    [ -f "${d}manifest.json" ] && list="${list:+$list,}${d%/}"
  done
fi
if [ -n "$list" ]; then exec "$HERE/Helium" --user-data-dir="$DATA" --load-extension="$list" "$@"; fi
exec "$HERE/Helium" --user-data-dir="$DATA" "$@"
'''

def ext_id(der):
    return ''.join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])

# ---- tiny protobuf reader, just enough for the CRX3 header ----
def _varint(b, i):
    n = s = 0
    while True:
        c = b[i]; i += 1; n |= (c & 0x7F) << s; s += 7
        if not c & 0x80: return n, i

def _fields(b):
    i = 0
    while i < len(b):
        tag, i = _varint(b, i); f, w = tag >> 3, tag & 7
        if w == 0: v, i = _varint(b, i)
        elif w == 2:
            n, i = _varint(b, i); v = b[i:i + n]; i += n
        elif w == 1: v = b[i:i + 8]; i += 8
        elif w == 5: v = b[i:i + 4]; i += 4
        else: raise ValueError('bad wire type')
        yield f, v

def read_crx(path):
    """returns (zip bytes, public key DER, id) for a CRX3 file"""
    d = open(path, 'rb').read()
    if d[:4] != b'Cr24': raise ValueError('not a Chrome extension (.crx) file: ' + path)
    ver, hlen = struct.unpack_from('<II', d, 4)
    if ver != 3: raise ValueError('unsupported crx version %d (need 3)' % ver)
    header, body = d[12:12 + hlen], d[12 + hlen:]
    keys, crx_id = [], None
    for f, v in _fields(header):
        if f in (2, 3):                                   # sha256_with_rsa / sha256_with_ecdsa
            for g, w in _fields(v):
                if g == 1: keys.append(w)                 # public_key
        elif f == 10000:                                  # signed_header_data
            for g, w in _fields(v):
                if g == 1: crx_id = bytes(w)
    key = next((k for k in keys if crx_id and hashlib.sha256(k).digest()[:16] == crx_id), keys[0] if keys else None)
    if key is None: raise ValueError('no public key in the crx header')
    return body, key, ext_id(key)

def unpack_crx(crx, dest):
    body, key, eid = read_crx(crx)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        for m in z.infolist():
            p = os.path.normpath(os.path.join(dest, m.filename))
            if not p.startswith(os.path.abspath(dest) + os.sep) and p != os.path.abspath(dest):
                raise ValueError('unsafe path in crx: ' + m.filename)
        z.extractall(dest)
    shutil.rmtree(os.path.join(dest, '_metadata'), ignore_errors=True)   # store bookkeeping; not needed for an unpacked copy
    mp = os.path.join(dest, 'manifest.json')
    with open(mp, encoding='utf-8-sig') as f: m = json.load(f)
    m['key'] = base64.b64encode(key).decode()             # pins the id, so it matches the Web Store id wherever the app lives
    with open(mp, 'w', encoding='utf-8') as f: json.dump(m, f, ensure_ascii=False, indent=2)
    return eid, m.get('name'), m.get('version')

def main(app, crx=None, native=False):
    app = os.path.abspath(app)
    ip = os.path.join(app, 'Contents', 'Info.plist')
    assert os.path.isfile(ip), 'not an app bundle: ' + app
    root = os.path.join(app, 'Contents', 'Resources', 'nexus-extensions')
    shutil.rmtree(root, ignore_errors=True); os.makedirs(root)
    pins = [UBLOCK_ID]

    # 1. Our own extensions (each manifest carries a fixed key, so the id is the same wherever the app lives)
    own = [('nexus-chat', 'Chat with Nexus', True)] if native else [('nexus-chat', 'Chat with Nexus', True), ('nexus-vault', 'Nexus Vault', True), ('nexus-authenticator', 'Nexus Authenticator', True), ('nexus-core-connect', 'Nexus Core Connect', True)]
    # "Convert to it!" (nexus://convert): only when fetch_convert.sh has built it (it has no toolbar icon, so it is not pinned)
    if os.path.isfile(os.path.join(HERE, 'nexus-convert', 'index.html')): own.append(('nexus-convert', 'Convert with Nexus', False))
    else: print('  Convert to it!: not built yet (run fetch_convert.sh), skipped')
    for folder, label, pin in own:
        src = os.path.join(HERE, folder); dst = os.path.join(root, folder)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns('.DS_Store', 'README.txt', '__MACOSX'))
        with open(os.path.join(dst, 'manifest.json'), encoding='utf-8') as f: key = json.load(f)['key']
        eid = ext_id(base64.b64decode(key))
        if pin: pins.append(eid)
        print('  built in: %s  (id %s)' % (label, eid))

    # 2. Proton VPN (optional: only when its .crx has been fetched)
    if native:
        pins += [VAULT_ID, PROTON_ID, AUTHENTICATOR_ID, CORE_CONNECT_ID]
        print('  native build: Nexus Vault, Nexus Authenticator and Proton VPN are already inside the browser')
    elif crx and os.path.isfile(crx):
        eid, name, ver = unpack_crx(crx, os.path.join(root, 'proton-vpn'))
        if eid != PROTON_ID:
            print('  WARNING: this .crx has id %s, not the expected Proton VPN id %s. Built in anyway.' % (eid, PROTON_ID))
        pins.append(eid)
        print('  built in: %s %s  (id %s)' % (name, ver, eid))
    else:
        print('  Proton VPN: no .crx given, skipped')

    with open(os.path.join(root, 'pins.txt'), 'w') as f: f.write('\n'.join(pins) + '\n')

    bg = os.path.join(HERE, 'assets', 'default_background.jpg')
    if os.path.isfile(bg):
        shutil.copy(bg, os.path.join(app, 'Contents', 'Resources', 'nexus-default-background.jpg'))
        print('  default new-tab wallpaper installed')

    # 3. launcher
    macos = os.path.join(app, 'Contents', 'MacOS')
    with open(ip, 'rb') as f: pl = plistlib.load(f)
    real = pl['CFBundleExecutable']
    if real == 'Nexus':
        main_exe = os.path.join(macos, 'Nexus')
        with open(main_exe, 'rb') as f: is_script = f.read(2) == b'#!'
        if not is_script:
            # An app compiled from the Nexus source: its real browser binary is already called Nexus.
            # Move it aside so the launcher can take the name Nexus (CFBundleExecutable stays Nexus).
            os.replace(main_exe, os.path.join(macos, 'NexusBrowser'))
            real = 'NexusBrowser'
        elif os.path.isfile(os.path.join(macos, 'NexusBrowser')):
            real = 'NexusBrowser'                     # running again on a patched native build
        else:
            real = 'Helium'                           # running again on an app that was already patched
    assert os.path.isfile(os.path.join(macos, real)), 'real executable missing: ' + real
    script = LAUNCHER.replace('"$HERE/Helium"', '"$HERE/%s"' % real)
    lp = os.path.join(macos, 'Nexus')
    with open(lp, 'w') as f: f.write(script)
    os.chmod(lp, os.stat(lp).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    pl['CFBundleExecutable'] = 'Nexus'
    with open(ip, 'wb') as f: plistlib.dump(pl, f)
    print('  launcher installed (starts %s with the built-in extensions)' % real)

if __name__ == '__main__':
    a = sys.argv[1:]
    main(a[0], a[a.index('--crx') + 1] if '--crx' in a else None, native='--native' in a)
