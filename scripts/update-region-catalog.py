"""Maintainer refresh of the official public code catalog; no account/API key needed."""
import csv,gzip,hashlib,io,json,pathlib,urllib.parse,urllib.request,zipfile,datetime
root=pathlib.Path(__file__).resolve().parents[1]
source='https://www.code.go.kr/stdcode/regCodeL.do?menuNo=101010100010'
url='https://www.code.go.kr/etc/codeFullDown.do'
def build(raw):
 rows=list(csv.DictReader(io.StringIO(raw.decode('cp949')),delimiter='\t'))
 active=[[r['법정동코드'],r['법정동명']] for r in rows if r['폐지여부']=='존재']
 if len(active)<10000 or any(len(c)!=10 or not c.isdigit() or not n for c,n in active):raise ValueError('Unexpected official catalog format')
 provinces=[r for r in active if r[0].endswith('00000000')]
 if len(provinces)<10 or len(set(c for c,n in active))!=len(active):raise ValueError('Incomplete or duplicate catalog')
 payload={'retrievedOn':datetime.datetime.now(datetime.timezone.utc).date().isoformat(),'sourceUrl':source,'downloadUrl':url,'rows':active}
 b=json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode()
 out=root/'data/legal-dong.json.gz';out.write_bytes(gzip.compress(b,mtime=0))
 (root/'data/legal-dong-meta.json').write_text(json.dumps({'retrievedOn':payload['retrievedOn'],'sourceUrl':source,'sha256':hashlib.sha256(b).hexdigest(),'activeCodes':len(active),'collectionRegions':sum(not c.endswith('00000') for c,n in active)},ensure_ascii=False,indent=2)+'\n')
 print('Official active codes:',len(active),'compressed bytes:',out.stat().st_size)
if __name__=='__main__':
 request=urllib.request.Request(url,data=urllib.parse.urlencode({'codeseId':'법정동코드'}).encode(),headers={'Referer':source})
 with urllib.request.urlopen(request,timeout=45) as response:archive=zipfile.ZipFile(io.BytesIO(response.read()))
 files=[n for n in archive.namelist() if n.endswith('.txt')]
 if len(files)!=1:raise ValueError('Unexpected official download archive')
 build(archive.read(files[0]))
