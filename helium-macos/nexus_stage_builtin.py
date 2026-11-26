#!/usr/bin/env python3
"""Copy Nexus's built-in extensions into the Chromium source tree before it is built.

usage: nexus_stage_builtin.py <chromium src dir> <nexus-rebrand dir>

Puts these in <src>/third_party/nexus_builtin/ (see patches/nexus/builtin-vault-vpn.patch):
  vault/          from <nexus-rebrand>/nexus-vault
  authenticator/  from <nexus-rebrand>/nexus-authenticator
  core_connect/   from <nexus-rebrand>/nexus-core-connect (pairs the browser with Nexus Core)
  proton_vpn/     unpacked from <nexus-rebrand>/vendor/proton-vpn.crx (downloaded once if it is not there)
The browser then ships all three inside itself, like uBlock Origin. Nothing is loaded at start-up.
"""
import importlib.util, json, os, shutil, sys, urllib.request

PROTON_ID = 'jplgfhpmjnbigmhklmmbgecoobifkmpa'
CRX_URL = ('https://clients2.google.com/service/update2/crx?response=redirect&prodversion=155.0.0.0'
           '&acceptformat=crx2,crx3&x=id%3D' + PROTON_ID + '%26installsource%3Dondemand%26uc')
MAX_FILES = 1400          # the id range reserved in tools/gritsettings/resource_ids.spec is 1500


def fail(msg):
    sys.exit('nexus_stage_builtin: ' + msg)


def load_builtin_module(rebrand):
    path = os.path.join(rebrand, 'nexus_builtin.py')
    spec = importlib.util.spec_from_file_location('nexus_builtin', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fetch_crx(dest):
    print('nexus_stage_builtin: downloading the Proton VPN extension (saved in vendor/)')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        with urllib.request.urlopen(CRX_URL, timeout=120) as r, open(dest + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        with open(dest + '.part', 'rb') as f:
            if f.read(4) != b'Cr24':
                raise ValueError('not a .crx file')
        os.replace(dest + '.part', dest)
    except Exception as e:
        if os.path.exists(dest + '.part'):
            os.remove(dest + '.part')
        fail('could not download Proton VPN (%s).\n  Download it once with  nexus-rebrand/build_nexus_dmg.sh --refresh-proton\n'
             '  or save the .crx as %s and run the build again.' % (e, dest))


def main(src, rebrand):
    src, rebrand = os.path.abspath(src), os.path.abspath(rebrand)
    if not os.path.isdir(os.path.join(src, 'chrome')):
        fail('not a Chromium source tree: ' + src)
    out = os.path.join(src, 'third_party', 'nexus_builtin')
    os.makedirs(out, exist_ok=True)     # the patch (patches/nexus/builtin-vault-vpn.patch) adds the BUILD files next to these

    # Nexus Vault
    vault_src = os.path.join(rebrand, 'nexus-vault')
    if not os.path.isfile(os.path.join(vault_src, 'manifest.json')):
        fail('nexus-vault/manifest.json not found in ' + rebrand)
    vault = os.path.join(out, 'vault')
    shutil.rmtree(vault, ignore_errors=True)
    shutil.copytree(vault_src, vault, ignore=shutil.ignore_patterns('.DS_Store', 'README.txt', '__MACOSX'))

    # Nexus Authenticator
    auth_src = os.path.join(rebrand, 'nexus-authenticator')
    if not os.path.isfile(os.path.join(auth_src, 'manifest.json')):
        fail('nexus-authenticator/manifest.json not found in ' + rebrand)
    auth = os.path.join(out, 'authenticator')
    shutil.rmtree(auth, ignore_errors=True)
    shutil.copytree(auth_src, auth, ignore=shutil.ignore_patterns('.DS_Store', 'README.txt', '__MACOSX'))

    # Nexus Core Connect
    cc_src = os.path.join(rebrand, 'nexus-core-connect')
    if not os.path.isfile(os.path.join(cc_src, 'manifest.json')):
        fail('nexus-core-connect/manifest.json not found in ' + rebrand)
    cc = os.path.join(out, 'core_connect')
    shutil.rmtree(cc, ignore_errors=True)
    shutil.copytree(cc_src, cc, ignore=shutil.ignore_patterns('.DS_Store', 'README.txt', '__MACOSX'))

    # Proton VPN
    crx = os.path.join(rebrand, 'vendor', 'proton-vpn.crx')
    if not os.path.isfile(crx) or os.path.getsize(crx) == 0:
        fetch_crx(crx)
    proton = os.path.join(out, 'proton_vpn')
    shutil.rmtree(proton, ignore_errors=True)
    mod = load_builtin_module(rebrand)
    eid, name, version = mod.unpack_crx(crx, proton)      # also adds the store "key" to the manifest
    if eid != PROTON_ID:
        fail('vendor/proton-vpn.crx has id %s, expected the Proton VPN id %s' % (eid, PROTON_ID))
    with open(os.path.join(proton, 'manifest.json'), encoding='utf-8') as f:
        m = json.load(f)
    if m.get('manifest_version') != 3:
        print('nexus_stage_builtin: note: Proton VPN manifest_version is %s' % m.get('manifest_version'))

    total = sum(len(fs) for d in (vault, auth, cc, proton) for _, _, fs in os.walk(d))
    if total > MAX_FILES:
        fail('%d files is more than the %d ids reserved in resource_ids.spec; raise the size there' % (total, MAX_FILES))
    print('nexus_stage_builtin: Nexus Vault + Nexus Authenticator + Nexus Core Connect + %s %s staged (%d files)' % (name, version, total))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
