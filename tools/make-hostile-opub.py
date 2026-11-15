# Makes a hostile .opub from a good one: colours that try to fetch from the network or break out
# of a style, a picture type that isn't one, a link that isn't a web address.
import json, zipfile, sys
src, dst = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
doc = json.loads(z.read('document.json'))
BAD = 'url(http://203.0.113.9/beacon.png)'
n = 0
def walk(v):
    global n
    if isinstance(v, dict):
        for k in list(v):
            if k in ('color', 'color2') and isinstance(v[k], str):
                v[k] = BAD; n += 1
            else:
                walk(v[k])
    elif isinstance(v, list):
        for x in v: walk(x)
walk(doc)
doc['pages'][0]['background'] = '#fff;background-image:url(http://203.0.113.9/bg.png)'
for s in doc['pages'][0]['shapes'][:3]:
    s['link'] = 'file:///C:/Windows/System32/calc.exe'
for im in doc.get('images', []):
    im['mime'] = 'text/html\r\nX-Injected: 1'
out = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)
out.writestr('document.json', json.dumps(doc))
for name in z.namelist():
    if name != 'document.json':
        out.writestr(name, z.read(name))
out.close()
print('hostile values written:', n)
