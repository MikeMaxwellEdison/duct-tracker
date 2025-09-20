import os, re, json, asyncio, time, hmac, hashlib, pathlib, shutil, datetime as dt
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, Request, Response, HTTPException, Depends, Path
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import aiosqlite, httpx

# --- ENV (names only) ---
CLIENT_ID=os.getenv('CLIENT_ID'); CLIENT_SECRET=os.getenv('CLIENT_SECRET'); TENANT_ID=os.getenv('TENANT_ID')
USER_UPN=os.getenv('USER_UPN'); DRIVE_ID=os.getenv('DRIVE_ID')
EXCEL_PATH=os.getenv('EXCEL_PATH') or '0. Master Tracker/NB - FD QA Checklist/Fire Damper ITC 1M-QA-FD-02.xlsx'
EXCEL_SHEET=os.getenv('EXCEL_SHEET') or 'ITC'
ROOMS_BASE=os.getenv('ROOMS_BASE') or '0. Master Tracker/Online Folders'
RUN_MODE=os.getenv('RUN_MODE') or 'RENDER'
ADMIN_PIN=os.getenv('ADMIN_PIN','devpin')  # set in Render

# --- Paths (runtime-safe) ---
DATA_DIR = pathlib.Path(os.getenv("DATA_DIR", str(pathlib.Path(__file__).parent / "data")))
DB_PATH = DATA_DIR / "server.db"
STATIC_DIR = pathlib.Path(__file__).parent/'static'
(DATA_DIR / "low").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "hi").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "notes").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "superseded").mkdir(parents=True, exist_ok=True)

app = FastAPI(title='duct-tracker-api', version='1.2.0')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])
app.mount('/static', StaticFiles(directory=str(STATIC_DIR), html=True), name='static')

def now_iso(): return dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat()
def sanitize(s:str)->str: return re.sub(r'[^a-zA-Z0-9_.-]+','_',s or '')

# --- Taxonomy ---
NON_REMOVABLE=['Clash / Issue','Duct Installed','Fire Rated','Grille Boxes Installed','Labelled','Penetrations Ready','Subframe & Grilles Installed']
GROUPS={
  'Ceiling Grid':['Ceiling Grid Installed','Ceiling Tile Ready'],
  'Lined Ceiling':['Ceiling Lined','Rondo Frame Ready'],
  'LR Fire Damper':['LR FD Actuator Installed','LR FD Actuator Wired','LR FD Installed','LR FD Tested'],
  'IBD Fire Damper':['IBD FD Installed','IBD FD Tested'],
  'VAV':['VAV Installed','VAV Wired'],
  'VCD':['VCD Actuator Installed','VCD Actuator Wired','VCD Installed'],
}
FD_DEP=['Access Panel Installed','SD Actuator Installed','SD Actuator Wired','SD Installed','SD Tested']

def compute_visible(included_groups:List[str])->set:
    vis=set(NON_REMOVABLE)
    for g in included_groups:
        for n in GROUPS.get(g,[]): vis.add(n)
    if ('LR Fire Damper' in included_groups) or ('IBD Fire Damper' in included_groups):
        for n in FD_DEP: vis.add(n)
    return vis

# --- DB ---
async def ensure_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS rooms_cache(id TEXT PRIMARY KEY,name TEXT,path TEXT,floor TEXT,updated_at TEXT,hidden INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS items_cache(id TEXT PRIMARY KEY,room_id TEXT,name TEXT,path TEXT,order_index INTEGER,hidden INTEGER DEFAULT 0,updated_at TEXT);
        CREATE TABLE IF NOT EXISTS status_events(id TEXT PRIMARY KEY,item_id TEXT,status TEXT,note TEXT,updated_at TEXT,client_id TEXT);
        CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,item_id TEXT,kind TEXT,created_at TEXT,server_id TEXT, superseded INTEGER DEFAULT 0);
        '''); await db.commit()
        # migration: ensure 'superseded' exists
        cur = await db.execute("PRAGMA table_info(photos)")
        cols = [r[1] for r in await cur.fetchall()]
        if 'superseded' not in cols:
            try:
                await db.execute("ALTER TABLE photos ADD COLUMN superseded INTEGER DEFAULT 0")
                await db.commit()
            except Exception:
                pass

@app.on_event('startup')
async def _startup():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    await ensure_db()
    asyncio.create_task(refresh_rooms_periodically())

# --- Graph (list-only placeholder; upload wiring later) ---
class Graph:
    def __init__(self, tenant, client_id, client_secret):
        self.tenant=tenant; self.client_id=client_id; self.client_secret=client_secret
        self.scopes=['https://graph.microsoft.com/.default']; self.token=None; self.expiry=0
    async def _auth(self):
        if not self.token or time.time()>self.expiry:
            url=f'https://login.microsoftonline.com/{self.tenant}/oauth2/v2.0/token'
            data={'client_id':self.client_id,'client_secret':self.client_secret,'grant_type':'client_credentials','scope':' '.join(self.scopes)}
            async with httpx.AsyncClient(timeout=30) as c:
                r=await c.post(url,data=data); r.raise_for_status(); tok=r.json()
                self.token=tok['access_token']; self.expiry=time.time()+float(tok.get('expires_in',3600))-120
        return {'Authorization': f'Bearer {self.token}'}
    async def list_children(self, drive_id, path):
        h=await self._auth()
        url=f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{path}:/children?$top=999'
        async with httpx.AsyncClient(timeout=60) as c:
            r=await c.get(url,headers=h); r.raise_for_status(); return r.json().get('value',[])

graph = Graph(TENANT_ID, CLIENT_ID, CLIENT_SECRET) if all([TENANT_ID,CLIENT_ID,CLIENT_SECRET]) else None
ROOM_NAME_FLOOR = re.compile(r'\b(N-[01])')

async def scan_rooms():
    rooms=[]
    if graph and DRIVE_ID and ROOMS_BASE:
        try:
            children = await graph.list_children(DRIVE_ID, ROOMS_BASE)
            for ch in children:
                if ch.get('folder'):
                    rid=ch['name']; m=ROOM_NAME_FLOOR.search(rid); floor=m.group(1) if m else ''
                    rooms.append({'id':rid,'name':rid,'path':f'{ROOMS_BASE}/{rid}','floor':floor,'updatedAt':now_iso(),'hidden':0})
        except Exception:
            pass
    return rooms

async def refresh_rooms_periodically():
    while True:
        try:
            rooms=await scan_rooms()
            if rooms:
                async with aiosqlite.connect(DB_PATH) as db:
                    for r in rooms:
                        await db.execute('INSERT INTO rooms_cache(id,name,path,floor,updated_at,hidden) VALUES(?,?,?,?,?,COALESCE((SELECT hidden FROM rooms_cache WHERE id=?),0)) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,floor=excluded.floor,updated_at=excluded.updated_at', (r['id'],r['name'],r['path'],r['floor'],r['updatedAt'],r['id']))
                    await db.commit()
        except Exception:
            pass
        await asyncio.sleep(300)

async def items_for_room(room_id:str):
    path=None
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute('SELECT path FROM rooms_cache WHERE id=?',(room_id,)); row=await cur.fetchone()
        if row: path=row[0]
    out=[]
    if graph and DRIVE_ID and path:
        try:
            children=await graph.list_children(DRIVE_ID, path)
            for idx,ch in enumerate(children):
                if ch.get('folder'):
                    iid=f'{room_id}::{ch["name"]}'
                    out.append({'id':iid,'roomId':room_id,'name':ch['name'],'path':f'{path}/{ch["name"]}','orderIndex':idx,'hidden':0,'updatedAt':now_iso()})
        except Exception:
            pass
    if not out:
        base=NON_REMOVABLE.copy()
        for i,n in enumerate(base): out.append({'id':f'{room_id}::{n}','roomId':room_id,'name':n,'path':'','orderIndex':i,'hidden':0,'updatedAt':now_iso()})
    async with aiosqlite.connect(DB_PATH) as db:
        for it in out:
            await db.execute('INSERT INTO items_cache(id,room_id,name,path,order_index,hidden,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,order_index=excluded.order_index,updated_at=excluded.updated_at',(it['id'],it['roomId'],it['name'],it['path'],it['orderIndex'],it['hidden'],it['updatedAt']))
        await db.commit()
    return out

# --- Admin session cookie ---
def sign_admin(exp:int)->str:
    msg=f'adm|{exp}'.encode(); sig=hmac.new(ADMIN_PIN.encode(), msg, hashlib.sha256).hexdigest(); return f'{exp}.{sig}'
def verify_admin(token:str)->bool:
    try:
        exp_s, sig = token.split('.',1); exp=int(exp_s)
        if time.time()>exp: return False
        expect=hmac.new(ADMIN_PIN.encode(), f'adm|{exp}'.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expect, sig)
    except Exception:
        return False

async def require_admin(request:Request):
    token = request.cookies.get('adm','')
    if not token or not verify_admin(token): raise HTTPException(status_code=401, detail='admin required')

# --- API ---
@app.get('/healthz')
async def healthz(): return {'ok':True,'time':now_iso()}

@app.get('/api/rooms')
async def api_rooms():
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute('SELECT id,name,path,floor,updated_at,hidden FROM rooms_cache ORDER BY id'); rows=await cur.fetchall()
    if not rows:
        rooms=await scan_rooms()
        if not rooms: return JSONResponse([], media_type='application/json')
        async with aiosqlite.connect(DB_PATH) as db:
            for r in rooms:
                await db.execute('INSERT OR REPLACE INTO rooms_cache(id,name,path,floor,updated_at,hidden) VALUES(?,?,?,?,?,0)',(r['id'],r['name'],r['path'],r['floor'],r['updatedAt']))
            await db.commit()
        return rooms
    return [{'id':r[0],'name':r[1],'path':r[2],'floor':r[3],'updatedAt':r[4],'hidden':r[5]} for r in rows]

@app.get('/api/rooms/{room_id}/items')
async def api_room_items(room_id:str):
    items=await items_for_room(room_id)
    async with aiosqlite.connect(DB_PATH) as db:
        out=[]
        for it in items:
            cur=await db.execute('SELECT status,note,updated_at FROM status_events WHERE item_id=? ORDER BY updated_at DESC LIMIT 1',(it['id'],)); row=await cur.fetchone()
            s=row[0] if row else 'NA'; note=row[1] if row else ''
            out.append({**it,'status':s,'note':note})
    return out

@app.post('/api/items/{item_id}/status')
async def api_status(item_id:str, status:str=Form(...), note:Optional[str]=Form(None), updatedAt:Optional[str]=Form(None), clientId:Optional[str]=Form(None)):
    key=(item_id,status or '',note or '',updatedAt or '',clientId or '')
    eid=hashlib.sha256(('|'.join(key)).encode()).hexdigest()
    when = updatedAt or now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('INSERT OR IGNORE INTO status_events(id,item_id,status,note,updated_at,client_id) VALUES(?,?,?,?,?,?)',(eid,item_id,status,note,when,clientId)); await db.commit()
    return {'ok':True,'id':eid}

@app.post('/api/items/{item_id}/note')
async def api_note(item_id:str, req:Request):
    body=await req.json()
    text=(body or {}).get('text','').strip()
    if not text: return {'ok':True}
    safe = sanitize(item_id)
    folder = DATA_DIR / 'notes' / safe
    folder.mkdir(parents=True, exist_ok=True)
    line = f"{now_iso()} - {text}\n"
    (folder/'NOTES.txt').write_text(((folder/'NOTES.txt').read_text() if (folder/'NOTES.txt').exists() else '') + line, encoding='utf-8')
    return {'ok':True}

@app.post('/api/photos/lowres')
async def api_low(itemId:str=Form(...), photoId:str=Form(...), createdAt:str=Form(...), file:UploadFile=File(...)):
    (DATA_DIR/'low').mkdir(parents=True, exist_ok=True)
    (DATA_DIR/'low'/f'{photoId}.jpg').write_bytes(await file.read())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('INSERT OR IGNORE INTO photos(id,item_id,kind,created_at,server_id,superseded) VALUES(?,?,?,?,?,0)',(photoId,itemId,'LOW',createdAt,hashlib.md5((photoId+"low").encode()).hexdigest())); await db.commit()
    return {'ok':True}

@app.post('/api/photos/hires')
async def api_hi(itemId:str=Form(...), photoId:str=Form(...), file:UploadFile=File(...)):
    (DATA_DIR/'hi').mkdir(parents=True, exist_ok=True)
    (DATA_DIR/'hi'/f'{photoId}.jpg').write_bytes(await file.read())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('INSERT OR IGNORE INTO photos(id,item_id,kind,created_at,server_id,superseded) VALUES(?,?,?,?,?,0)',(photoId,itemId,'HI',now_iso(),'')); await db.commit()
    return {'ok':True}

@app.get('/api/items/{item_id}/photos')
async def api_ph(item_id:str):
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute('SELECT id,kind,created_at,server_id FROM photos WHERE item_id=? AND IFNULL(superseded,0)=0',(item_id,)); rows=await cur.fetchall()
    return [{'id':r[0],'kind':r[1],'createdAt':r[2],'serverId':r[3]} for r in rows]

@app.post('/api/photos/{photo_id}/supersede')
async def api_sup(photo_id:str, req:Request):
    body=await req.json()
    itemId=(body or {}).get('itemId','')
    safe = sanitize(itemId)
    outdir = DATA_DIR/'superseded'/safe
    outdir.mkdir(parents=True, exist_ok=True)
    # move local files if they exist
    for kind, sub in [('LOW','low'),('HI','hi')]:
        src = DATA_DIR/sub/f'{photo_id}.jpg'
        if src.exists():
            dst = outdir/f'{photo_id}.{sub}.jpg'
            try: shutil.move(str(src), str(dst))
            except Exception: pass
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('UPDATE photos SET superseded=1 WHERE id=?',(photo_id,))
        await db.commit()
    return {'ok':True}

# --- Admin ---
def redirect_after_hide(hide:bool)->str:
    return '/' if hide else ''

@app.post('/api/admin/login')
async def admin_login(req:Request, resp:Response):
    body = await req.json()
    pin = (body or {}).get('pin','')
    if (os.getenv('ADMIN_PIN') and pin!=ADMIN_PIN) or (not pin):
        raise HTTPException(status_code=401, detail='bad pin')
    exp=int(time.time()+30*60)
    token = f'{exp}.{hmac.new(ADMIN_PIN.encode(), f"adm|{exp}".encode(), hashlib.sha256).hexdigest()}'
    resp.set_cookie('adm', token, httponly=True, samesite='lax', max_age=30*60, secure=True)
    return {'ok':True,'until':exp}

async def require_admin(request:Request):
    token = request.cookies.get('adm','')
    try:
        exp_s, sig = token.split('.',1); exp=int(exp_s)
        expect=hmac.new(ADMIN_PIN.encode(), f"adm|{exp}".encode(), hashlib.sha256).hexdigest()
        if time.time()>exp or not hmac.compare_digest(expect, sig): raise ValueError()
    except Exception: raise HTTPException(status_code=401, detail='admin required')

@app.get('/api/admin/room-config/{room_id}')
async def get_room_cfg(room_id:str, _:Any=Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute('SELECT hidden FROM rooms_cache WHERE id=?',(room_id,)); rr=await cur.fetchone()
        hide_room = bool(rr[0]) if rr else False
        cur=await db.execute('SELECT name,hidden FROM items_cache WHERE room_id=?',(room_id,)); rows=await cur.fetchall()
    names_visible = {n for (n,h) in rows if h==0}
    included=[]
    for g,names in GROUPS.items():
        if all(name in names_visible for name in names): included.append(g)
    return {'roomId':room_id,'includeGroups':included,'hideRoom':hide_room}

@app.post('/api/admin/room-config/{room_id}')
async def set_room_cfg(room_id:str, req:Request, _:Any=Depends(require_admin)):
    body = await req.json()
    includeGroups = body.get('includeGroups',[]) or []
    hideRoom = bool(body.get('hideRoom', False))
    visible = compute_visible(includeGroups)
    items = await items_for_room(room_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('UPDATE rooms_cache SET hidden=? WHERE id=?',(1 if hideRoom else 0, room_id))
        for it in items:
            new_hidden = 0 if (it['name'] in visible or it['name'] in NON_REMOVABLE) else 1
            await db.execute('UPDATE items_cache SET hidden=? WHERE id=?',(new_hidden, it['id']))
        await db.commit()
    return {'ok':True,'redirect': redirect_after_hide(hideRoom)}

@app.post('/api/admin/rooms/hidden-batch')
async def batch_hide(req:Request, _:Any=Depends(require_admin)):
    body=await req.json()
    rooms=body.get('rooms',[])
    async with aiosqlite.connect(DB_PATH) as db:
        for r in rooms:
            await db.execute('UPDATE rooms_cache SET hidden=? WHERE id=?',(1 if r.get('hidden') else 0, r['id']))
        await db.commit()
    return {'ok':True}

@app.get('/api/metrics')
async def api_metrics():
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute('SELECT id,floor,hidden FROM rooms_cache'); rooms=await cur.fetchall()
        floor={}
        for rid,floor_id,hidden in rooms:
            if hidden: continue
            curi=await db.execute('SELECT id,hidden FROM items_cache WHERE room_id=?',(rid,)); items=await curi.fetchall()
            visible=[iid for iid,h in items if h==0] or []
            pass_na=0
            for iid in visible:
                cur2=await db.execute('SELECT status FROM status_events WHERE item_id=? ORDER BY updated_at DESC LIMIT 1',(iid,)); r2=await cur2.fetchone()
                s=r2[0] if r2 else 'NA'
                if s in ('PASS','NA'): pass_na+=1
            total=max(len(visible),1); done=1 if pass_na==total else 0
            k=floor_id or 'UNK'; floor.setdefault(k,{'rooms':0,'complete':0}); floor[k]['rooms']+=1; floor[k]['complete']+=done
    return {'floors':floor,'time':now_iso()}

# --- Media routes ---
@app.get("/media/low/{photo_id}.jpg")
async def media_low(photo_id:str=Path(...)):
    p = DATA_DIR / "low" / f"{photo_id}.jpg"
    if not p.exists(): raise HTTPException(status_code=404)
    return FileResponse(str(p), media_type="image/jpeg")

@app.get("/media/hi/{photo_id}.jpg")
async def media_hi(photo_id:str=Path(...)):
    p = DATA_DIR / "hi" / f"{photo_id}.jpg"
    if not p.exists(): raise HTTPException(status_code=404)
    return FileResponse(str(p), media_type="image/jpeg")

# --- Simple sync pause/resume toggles (placeholder for Graph push) ---
SYNC_PAUSED=False
@app.post('/api/sync/pause')
async def sync_pause(): 
    global SYNC_PAUSED; SYNC_PAUSED=True; return {'ok':True,'paused':True}
@app.post('/api/sync/resume')
async def sync_resume(): 
    global SYNC_PAUSED; SYNC_PAUSED=False; return {'ok':True,'paused':False}

# --- SPA routes ---
@app.get('/', response_class=HTMLResponse)
async def index(): return FileResponse(str(STATIC_DIR/'index.html'))
@app.get('/room/{room_id}', response_class=HTMLResponse)
@app.get('/qa/fd/{damper_id}', response_class=HTMLResponse)
@app.get('/admin', response_class=HTMLResponse)
def spa_routes(room_id:Optional[str]=None, damper_id:Optional[str]=None): return FileResponse(str(STATIC_DIR/'index.html'))
