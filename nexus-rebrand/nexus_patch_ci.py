#!/usr/bin/env python3
"""Best-effort Nexus look for an app that was COMPILED from the Nexus source.
usage: nexus_patch_ci.py /path/to/Nexus.app

nexus_patch.py expects a stock Helium.app and stops at the first thing it does not recognise. This one tries the
same changes (app icon, logos, leftover "Helium" words) one at a time and just prints SKIP for any that do not fit,
so one mismatch cannot undo the rest. Run it BEFORE re-signing the app. Needs nexus_patch.py and nexus_pak.py next to it."""
import os, sys, glob, plistlib, shutil, gzip, base64
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nexus_patch as P
from nexus_pak import read_pak, write_pak

def step(name, fn, *a):
    try:
        r = fn(*a)
        print('ok    ' + name)
        return r
    except Exception as e:
        print('SKIP  %s -> %s' % (name, repr(e)[:220]))

def plist(app):
    ip = os.path.join(app, 'Contents', 'Info.plist')
    with open(ip, 'rb') as f: pl = plistlib.load(f)
    pl.pop('CFBundleIconName', None)          # otherwise macOS uses the Helium icon from Assets.car
    with open(ip, 'wb') as f: plistlib.dump(pl, f)
    shutil.copyfile(os.path.join(P.A, 'app.icns'), os.path.join(app, 'Contents', 'Resources', 'app.icns'))

def locale_pak(p):
    enc, order, res, als = read_pak(p)
    for rid in order:
        try: s = res[rid].decode('utf-8')
        except UnicodeDecodeError: continue
        if 'Helium' in s: res[rid] = P.rename(s).encode('utf-8')
    write_pak(p, enc, order, res, als)

def image_pak(p, fn):
    enc, order, res, als = read_pak(p)
    for role, rid in P.role_ids(res).items():
        res[rid] = P.png_for(fn, role)
    write_pak(p, enc, order, res, als)

def resources_pak(p):
    """resources.pak: every change is tried on its own, so a part this build does not have cannot undo the rest."""
    enc, order, res, als = read_pak(p)
    def sub(name, fn):
        try: fn(); print('      ok    ' + name)
        except Exception as e: print('      SKIP  %s -> %s' % (name, repr(e)[:150]))
    def swap(rid, fn, text=None):
        d = gzip.decompress(res[rid])
        for a, b in text: d = d.replace(a, b)
        res[rid] = gzip.compress(d, 9, mtime=0)

    def logos():
        n = 0
        for rid, fn in P.RES_LOGOS.items():
            if rid in res and res[rid][:4] == b'\x89PNG': res[rid] = P.asset(fn); n += 1
        assert n, 'none of the known logo ids is a PNG in this build'
    def svg_logo():
        assert res[P.ID_LOGO_SVG][:2] == b'\x1f\x8b'
        b64 = base64.b64encode(P.asset('nexus_cat_256.png')).decode()
        svg = ('<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" '
               'xmlns:xlink="http://www.w3.org/1999/xlink"><image width="256" height="256" '
               'href="data:image/png;base64,%s" xlink:href="data:image/png;base64,%s"/></svg>' % (b64, b64))
        res[P.ID_LOGO_SVG] = gzip.compress(svg.encode(), 9, mtime=0)
    def setup_page():
        rid = None
        for needle in (b'<title>Helium Setup</title>', b'<title>Nexus Setup</title>'):
            try: rid = P.find_gz(res, needle); break
            except AssertionError: pass
        assert rid is not None, 'setup page not found'
        if res.get(rid - 1, b'')[:4] == b'\x89PNG': res[rid - 1] = P.asset('nexus_cat_128.png')
        d = gzip.decompress(res[rid]).replace(b'<title>Helium Setup</title>', b'<title>Nexus Setup</title>')
        res[rid] = gzip.compress(d, 9, mtime=0)
    def fork_text():
        rid = P.find_gz(res, b'Helium fork:'); swap(rid, None, [(b'Helium fork:', b'Nexus fork:')])
    def visible(needle, subs):
        def go():
            rid = P.find_gz(res, needle)
            t = gzip.decompress(res[rid])
            assert any(a in t for a, b in subs), 'text not found'
            for a, b in subs: t = t.replace(a, b)
            res[rid] = gzip.compress(t, 9, mtime=0)
        return go

    sub('logo images', logos)
    sub('about/error page logo (svg)', svg_logo)
    sub('setup page logo + title', setup_page)
    sub('setup page inline logo (helium://setup)', lambda: P.patch_setup_logo(res))
    sub('"Helium fork:" text', fork_text)
    sub('"Add to Helium" button text', visible(b'replaceDownloadButtonText', [(b", 'Helium');", b", 'Nexus');")]))
    sub('uBlock about page', visible(b'#aboutNameVer', [(b'(Helium)`', b'(Nexus)`')]))
    sub('uBlock filter list names', visible(b'"parent": "Helium filters"', [(b'"parent": "Helium filters"', b'"parent": "Nexus filters"'),
        ('"title": "Helium filters \u2013 '.encode(), '"title": "Nexus filters \u2013 '.encode())]))
    write_pak(p, enc, order, res, als)

def main(app):
    app = os.path.abspath(app)
    assert os.path.isdir(os.path.join(app, 'Contents')), 'not an app bundle: ' + app
    step('Info.plist + app.icns', plist, app)
    for root, dirs, files in os.walk(app):
        for fn in files:
            p = os.path.join(root, fn)
            if os.path.islink(p): continue
            if fn == 'locale.pak': step('names in ' + os.path.relpath(p, app)[-60:], locale_pak, p)
            elif fn in ('chrome_100_percent.pak', 'chrome_200_percent.pak'): step(fn, image_pak, p, fn)
            elif fn == 'resources.pak': step('resources.pak', resources_pak, p)
            elif fn == 'product_logo_32.png' and root.endswith('Resources'):
                step('product_logo_32.png', lambda q: open(q, 'wb').write(P.asset('nexus_cat_32.png')), p)
    print('done. Re-sign the app before using it.')

if __name__ == '__main__':
    main(sys.argv[1])
