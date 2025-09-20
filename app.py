import os, re, json, asyncio, time, hmac, hashlib, pathlib, shutil, datetime as dt
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, Request, HTTPException, Path
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import aiosqlite, httpx

# ---- ENV (names only; never print secrets) ----
CLIENT_ID=os.getenv("CLIENT_ID"); CLIENT_SECRET=os.getenv("CLIENT_SECRET"); TENANT_ID=os.getenv("TENANT_ID")
USER_UPN=os.getenv("USER_UPN"); DRIVE_ID=os.getenv("DRIVE_ID")
EXCEL_PATH=os.getenv("EXCEL_PATH") or "0. Master Tracker/NB - FD QA Checklist/Fire Damper ITC 1M-QA-FD-02.xlsx"
EXCEL_SHEET=os.getenv("EXCEL_SHEET") or "ITC"
ROOMS_BASE=os.getenv("ROOMS_BASE") or "0. Master Tracker/Online Folders"
RUN_MODE=os.getenv("RUN_MODE") or "RENDER"
ADMIN_PIN=os.getenv("ADMIN_PIN","devpin")

DATA_DIR = pathlib.Path(os.getenv("DATA_DIR", str(pathlib.Path(__file__).parent / "data")))
STATIC_DIR = pathlib.Path(__file__).parent/'static'
DB_PATH   = DATA_DIR / "server.db"
for d in ["low","hi","notes","superseded"]: (DATA_DIR/d).mkdir(parents=True, exist_ok=True)

# ---- Constants / ordering ----
NON_REMOVABLE=[
  'Clash / Issue','Duct Installed','Fire Rated','Grille Boxes Installed','Labelled','Penetrations Ready','Subframe & Grilles Installed'
]
GROUPS={
  'Ceiling Grid':['Ceiling Grid Installed','Ceiling Tile Ready'],
  'Lined Ceiling':['Ceiling Lined','Rondo Frame Ready'],
  'LR Fire Damper':['LR FD Actuator Installed','LR FD Actuator Wired','LR FD Installed','LR FD Tested'],
  'IBD Fire Damper':['IBD FD Installed','IBD FD Tested'],
  'VAV':['VAV Installed','VAV Wired'],
  'VCD':['VCD Actuator Installed','VCD Actuator Wired','VCD Installed'],
}
FD_DEP=['Access Panel Installed','SD Actuator Installed','SD Actuator Wired','SD Installed','SD Tested']
GLOBAL_ORDER=[
  "Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed",
  "Ceiling Grid Installed","Ceiling Tile Ready","Ceiling Lined","Rondo Frame Ready",
  "LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested",
  "IBD FD Installed","IBD FD Tested","Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested",
  "VAV Installed","VAV Wired","VCD Actuator Installed","VCD Actuator Wired","VCD Installed"
]

def compute_visible(included_groups:List[str])->set:
    vis=set(NON_REMOVABLE)
    for g in included_groups:
        for n in GROUPS.get(g,[]): vis.add(n)
    if ('LR Fire Damper' in included_groups) or ('IBD Fire Damper' in included_groups):
        for n in FD_DEP: vis.add(n)
    return vis

def now_iso(): return dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat()
def sanitize(s:str)->str: return re.sub(r"[^a-zA-Z0-9_.-]+","_",s or "")

app = FastAPI(title="duct-tracker-api", version="1.5.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

# ---- DB ----
async def ensure_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS rooms_cache(id TEXT PRIMARY KEY,name TEXT,path TEXT,floor TEXT,updated_at TEXT,hidden INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS items_cache(id TEXT PRIMARY KEY,room_id TEXT,name TEXT,path TEXT,order_index INTEGER,hidden INTEGER DEFAULT 0,updated_at TEXT);
        CREATE TABLE IF NOT EXISTS status_events(id TEXT PRIMARY KEY,item_id TEXT,status TEXT,note TEXT,updated_at TEXT,client_id TEXT);
        CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,item_id TEXT,kind TEXT,created_at TEXT,server_id TEXT, superseded INTEGER DEFAULT 0, onedrive_id TEXT);
        CREATE TABLE IF NOT EXISTS fd_links(a TEXT PRIMARY KEY, b TEXT);
        CREATE TABLE IF NOT EXISTS room_config(room_id TEXT PRIMARY KEY, include_groups TEXT, hide_room INTEGER DEFAULT 0);
        """); await db.commit()

# ---- Microsoft Graph client helpers ----
class Graph:
    def __init__(self, tenant, client_id, client_secret):
        self.tenant=tenant; self.client_id=client_id; self.client_secret=client_secret
        self.scopes=['https://graph.microsoft.com/.default']; self.token=None; self.expiry=0
    async def _auth(self)->Dict[str,str]:
        if not self.token or time.time()>self.expiry:
            url=f'https://login.microsoftonline.com/{self.tenant}/oauth2/v2.0/token'
            data={'client_id':self.client_id,'client_secret':self.client_secret,'grant_type':'client_credentials','scope':' '.join(self.scopes)}
            async with httpx.AsyncClient(timeout=30) as c:
                r=await c.post(url,data=data); r.raise_for_status()
                tok=r.json(); self.token=tok['access_token']; self.expiry=time.time()+float(tok.get('expires_in',3600))-120
        return {'Authorization': f'Bearer {self.token}'}

    async def ensure_folder_path(self, drive_id:str, path:str)->Dict[str,Any]:
        parts=[p for p in path.strip('/').split('/') if p]
        cur=""
        h=await self._auth()
        async with httpx.AsyncClient(timeout=60) as c:
            for i,p in enumerate(parts):
                cur = (cur + "/" + p) if cur else p
                r=await c.get(f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{cur}', headers=h)
                if r.status_code==200: continue
                parent_path="/".join(parts[:i]) if i>0 else ""
                parent_url=f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{parent_path}:/children' if parent_path else f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root/children'
                cr=await c.post(parent_url, headers={**h,'Content-Type':'application/json'}, json={"name":p,"folder":{},"@microsoft.graph.conflictBehavior":"replace"})
                cr.raise_for_status()
            rr=await c.get(f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{cur}', headers=h); rr.raise_for_status(); return rr.json()

    async def upload_small(self, drive_id:str, path:str, content:bytes)->Dict[str,Any]:
        h=await self._auth()
        url=f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{path}:/content'
        async with httpx.AsyncClient(timeout=120) as c:
            r=await c.put(url, headers=h, content=content); r.raise_for_status(); return r.json()

    async def upload_large(self, drive_id:str, path:str, content:bytes, chunk:int=5*1024*1024)->Dict[str,Any]:
        h=await self._auth()
        init=f'https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{path}:/createUploadSession'
        async with httpx.AsyncClient(timeout=600) as c:
            r=await c.post(init, headers={**h,'Content-Type':'application/json'}, json={"item":{"@microsoft.graph.conflictBehavior":"replace"}}); r.raise_for_status()
            up=r.json(); url=up['uploadUrl']; size=len(content); pos=0
            while pos<size:
                end=min(pos+chunk,size)-1
                hr=await c.put(url, headers={"Content-Length":str(end-pos+1),"Content-Range":f"bytes {pos}-{end}/{size}"}, content=content[pos:end+1])
                if hr.status_code in (200,201): return hr.json()
                if hr.status_code not in (202,204): hr.raise_for_status()
                pos=end+1
            return {"id":""}

    async def move_item(self, drive_id:str, item_id:str, new_parent_id:str)->Dict[str,Any]:
        """Move existing drive item to a folder by id"""
        h=await self._auth()
        url=f'https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{item_id}'
        async with httpx.AsyncClient(timeout=60) as c:
            r=await c.patch(url, headers={**h,'Content-Type':'application/json'}, json={"parentReference":{"id": new_parent_id}})
            r.raise_for_status(); return r.json()

graph = Graph(TENANT_ID, CLIENT_ID, CLIENT_SECRET) if all([TENANT_ID,CLIENT_ID,CLIENT_SECRET]) else None

# ---- Helpers ----
ROOM_NAME_FLOOR = re.compile(r"\b(N-[01])")

async def scan_rooms():
    rooms=[]
    if graph and DRIVE_ID and ROOMS_BASE:
        try:
            h=await graph._auth()
            url=f'https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{ROOMS_BASE}:/children?$top=999'
            async with httpx.AsyncClient(timeout=60) as c:
                r=await c.get(url,headers=h); r.raise_for_status()
                for ch in r.json().get("value",[]):
                    if ch.get("folder"):
                        rid=ch["name"]; m=ROOM_NAME_FLOOR.search(rid); floor=m.group(1) if m else ""
                        rooms.append({"id":rid,"name":rid,"path":f"{ROOMS_BASE}/{rid}","floor":floor,"updatedAt":now_iso(),"hidden":0})
        except Exception:
            pass
    return rooms

async def items_for_room(room_id:str):
    # try Graph first
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT path FROM rooms_cache WHERE id=?",(room_id,)); row=await cur.fetchone()
    path=row[0] if row else None
    out=[]
    if graph and DRIVE_ID and path:
        try:
            h=await graph._auth()
            url=f'https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{path}:/children?$top=999'
            async with httpx.AsyncClient(timeout=60) as c:
                r=await c.get(url,headers=h); r.raise_for_status()
                for idx,ch in enumerate(r.json().get("value",[])):
                    if ch.get("folder"):
                        iid=f"{room_id}::{ch['name']}"
                        out.append({'id':iid,'roomId':room_id,'name':ch['name'],'path':f'{path}/{ch["name"]}','orderIndex':idx,'hidden':0,'updatedAt':now_iso()})
        except Exception:
            pass
    # Ensure non-removables always exist
    names=set([it["name"] for it in out])
    for n in NON_REMOVABLE:
        if n not in names:
            out.append({'id':f'{room_id}::{n}','roomId':room_id,'name':n,'path':'','orderIndex':GLOBAL_ORDER.index(n) if n in GLOBAL_ORDER else 999,'hidden':0,'updatedAt':now_iso()})
    if not out:
        # baseline
        for i,n in enumerate(NON_REMOVABLE):
            out.append({'id':f'{room_id}::{n}','roomId':room_id,'name':n,'path':'','orderIndex':i,'hidden':0,'updatedAt':now_iso()})
    # persist/merge
    async with aiosqlite.connect(DB_PATH) as db:
        for it in out:
            await db.execute('INSERT INTO items_cache(id,room_id,name,path,order_index,hidden,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,order_index=excluded.order_index,updated_at=excluded.updated_at',(it['id'],it['roomId'],it['name'],it['path'],it['orderIndex'],it['hidden'],it['updatedAt']))
        await db.commit()
    return out

# ---- Admin session cookie ----
def _sign(exp:int)->str:
    return f"{exp}.{hmac.new(ADMIN_PIN.encode(),f'adm|{exp}'.encode(),hashlib.sha256).hexdigest()}"
def _verify(tok:str)->bool:
    try:
        exp_s,sig = tok.split('.',1); exp=int(exp_s)
        ok=hmac.compare_digest(sig,hmac.new(ADMIN_PIN.encode(),f"adm|{exp}".encode(),hashlib.sha256).hexdigest())
        return ok and time.time()<exp
    except: return False
async def require_admin(req:Request):
    t=req.cookies.get("adm",""); 
    if not t or not _verify(t): raise HTTPException(401,"admin required")

# ---- Startup / periodic ----
@app.on_event("startup")
async def _startup():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    await ensure_db()
    asyncio.create_task(_periodic())

async def _periodic():
    while True:
        try:
            await asyncio.sleep(300)
            rooms=await scan_rooms()
            if rooms:
                async with aiosqlite.connect(DB_PATH) as db:
                    for r in rooms:
                        await db.execute('INSERT INTO rooms_cache(id,name,path,floor,updated_at,hidden) VALUES(?,?,?,?,?,COALESCE((SELECT hidden FROM rooms_cache WHERE id=?),0)) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,floor=excluded.floor,updated_at=excluded.updated_at',(r['id'],r['name'],r['path'],r['floor'],r['updatedAt'],r['id']))
                    await db.commit()
        except: pass

# ---- API: health / rooms / items ----
@app.get("/healthz")
async def healthz(): return {"ok":True,"time":now_iso()}

@app.get("/api/rooms")
async def api_rooms():
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT id,name,path,floor,updated_at,hidden FROM rooms_cache ORDER BY id"); rows=await cur.fetchall()
    if not rows:
        rooms=await scan_rooms()
        if not rooms: return []
        async with aiosqlite.connect(DB_PATH) as db:
            for r in rooms:
                await db.execute("INSERT OR REPLACE INTO rooms_cache(id,name,path,floor,updated_at,hidden) VALUES(?,?,?,?,?,0)",(r['id'],r['name'],r['path'],r['floor'],r['updatedAt']))
            await db.commit()
        return rooms
    return [{"id":r[0],"name":r[1],"path":r[2],"floor":r[3],"updatedAt":r[4],"hidden":r[5]} for r in rows]

@app.get("/api/rooms/{room_id}/items")
async def api_room_items(room_id:str):
    items=await items_for_room(room_id)
    out=[]
    async with aiosqlite.connect(DB_PATH) as db:
        for it in items:
            cur=await db.execute("SELECT status,note,updated_at FROM status_events WHERE item_id=? ORDER BY updated_at DESC LIMIT 1",(it['id'],)); row=await cur.fetchone()
            status=row[0] if row else "NA"; note=row[1] if row else ""
            if not note:
                safe=sanitize(it['id']); nf=DATA_DIR/'notes'/safe/'NOTES.txt'
                if nf.exists():
                    lines=[ln.strip() for ln in nf.read_text(encoding="utf-8").splitlines() if ln.strip()]
                    if lines: note = lines[-1].split(" - ",1)[-1]
            out.append({**it,"status":status,"note":note})
    # maintain global order
    out.sort(key=lambda x: GLOBAL_ORDER.index(x["name"]) if x["name"] in GLOBAL_ORDER else 999)
    return out

@app.post("/api/items/{item_id}/status")
async def api_status(item_id:str, status:str=Form(...), note:Optional[str]=Form(None), updatedAt:Optional[str]=Form(None), clientId:Optional[str]=Form(None)):
    eid=hashlib.sha256(f"{item_id}|{status}|{note or ''}|{updatedAt or ''}|{clientId or ''}".encode()).hexdigest()
    when=updatedAt or now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("INSERT OR IGNORE INTO status_events(id,item_id,status,note,updated_at,client_id) VALUES(?,?,?,?,?,?)",(eid,item_id,status,note,when,clientId)); await db.commit()
        if "FD Tested" in item_id and status=="PASS":
            cur=await db.execute("SELECT b FROM fd_links WHERE a=?",(item_id,)); r=await cur.fetchone()
            if r:
                linked=r[0]
                eid2=hashlib.sha256(f"{linked}|PASS|propagated||{clientId or ''}".encode()).hexdigest()
                await db.execute("INSERT OR IGNORE INTO status_events(id,item_id,status,note,updated_at,client_id) VALUES(?,?,?,?,?,?)",(eid2,linked,"PASS","Propagated from linked",now_iso(),"server")); await db.commit()
    return {"ok":True,"id":eid}

@app.post("/api/items/{item_id}/note")
async def api_note(item_id:str, req:Request):
    body=await req.json(); text=(body or {}).get("text","").strip()
    if not text: return {"ok":True}
    safe=sanitize(item_id); folder=DATA_DIR/'notes'/safe; folder.mkdir(parents=True, exist_ok=True)
    line=f"{now_iso()} - {text}\n"
    notes=folder/'NOTES.txt'
    with open(notes,"a",encoding="utf-8") as f: f.write(line)
    return {"ok":True}

# ---- FD cross-room holds ----
@app.post("/api/fd/hold")
async def api_fd_hold(req:Request):
    body=await req.json()
    item_id=body.get("itemId",""); linked_room=body.get("linkedRoomId","")
    if not item_id or not linked_room: raise HTTPException(400,"itemId and linkedRoomId required")
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT id FROM items_cache WHERE room_id=? AND name LIKE '%FD Tested%'",(linked_room,))
        row=await cur.fetchone()
        if not row: raise HTTPException(404,"Linked room has no 'FD Tested' item")
        target=row[0]
        await db.execute("INSERT OR REPLACE INTO fd_links(a,b) VALUES(?,?)",(item_id,target))
        await db.execute("INSERT OR REPLACE INTO fd_links(a,b) VALUES(?,?)",(target,item_id))
        eid1=hashlib.sha256(f"{item_id}|FAIL||{now_iso()}".encode()).hexdigest()
        eid2=hashlib.sha256(f"{target}|FAIL||{now_iso()}".encode()).hexdigest()
        await db.execute("INSERT OR IGNORE INTO status_events(id,item_id,status,note,updated_at,client_id) VALUES(?,?,?,?,?,?)",(eid1,item_id,"FAIL","Hold created",now_iso(),"server"))
        await db.execute("INSERT OR IGNORE INTO status_events(id,item_id,status,note,updated_at,client_id) VALUES(?,?,?,?,?,?)",(eid2,target,"FAIL","Hold created (linked)",now_iso(),"server"))
        await db.commit()
    return {"ok":True,"linkedItemId":target}

# ---- Photos ----
@app.post("/api/photos/lowres")
async def api_low(itemId:str=Form(...), photoId:str=Form(...), createdAt:str=Form(...), file:UploadFile=File(...)):
    (DATA_DIR/'low').mkdir(parents=True, exist_ok=True)
    (DATA_DIR/'low'/f'{photoId}.jpg').write_bytes(await file.read())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("INSERT OR IGNORE INTO photos(id,item_id,kind,created_at,server_id,superseded,onedrive_id) VALUES(?,?,?,?,?,?,?)",(photoId,itemId,"LOW",createdAt,"",0,"")); await db.commit()
    return {"ok":True}

@app.post("/api/photos/hires")
async def api_hi(itemId:str=Form(...), photoId:str=Form(...), file:UploadFile=File(...)):
    (DATA_DIR/'hi').mkdir(parents=True, exist_ok=True)
    (DATA_DIR/'hi'/f'{photoId}.jpg').write_bytes(await file.read())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("INSERT OR IGNORE INTO photos(id,item_id,kind,created_at,server_id,superseded,onedrive_id) VALUES(?,?,?,?,?,?,?)",(photoId,itemId,"HI",now_iso(),"",0,"")); await db.commit()
    return {"ok":True}

@app.get("/api/items/{item_id}/photos")
async def api_ph(item_id:str):
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT id,kind,created_at,server_id FROM photos WHERE item_id=? AND IFNULL(superseded,0)=0",(item_id,)); rows=await cur.fetchall()
    return [{"id":r[0],"kind":r[1],"createdAt":r[2],"serverId":r[3]} for r in rows]

@app.post("/api/photos/{photo_id}/supersede")
async def api_sup(photo_id:str, req:Request):
    body=await req.json(); itemId=(body or {}).get("itemId","")
    safe=sanitize(itemId); outdir=DATA_DIR/'superseded'/safe; outdir.mkdir(parents=True, exist_ok=True)
    # fetch metadata
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT IFNULL(onedrive_id,''), item_id FROM photos WHERE id=?", (photo_id,))
        prow=await cur.fetchone()
        cur2=await db.execute("SELECT path FROM items_cache WHERE id=?", (itemId,))
        irow=await cur2.fetchone()
    od_id = (prow[0] if prow else "") or ""
    item_path = (irow[0] if irow else "") or ""
    # move local assets
    for kind, sub in [('LOW','low'),('HI','hi')]:
        src=DATA_DIR/sub/f'{photo_id}.jpg'
        if src.exists():
            dst=outdir/f'{photo_id}.{sub}.jpg'
            try: shutil.move(str(src), str(dst))
            except Exception: pass
    # mark superseded
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE photos SET superseded=1 WHERE id=?", (photo_id,)); await db.commit()
    # move in OneDrive if we have id
    if graph and DRIVE_ID and od_id and item_path:
        try:
            sup_path = f"{item_path}/Superseded"
            sup_item = await graph.ensure_folder_path(DRIVE_ID, sup_path)
            sup_id = sup_item.get("id","")
            if sup_id:
                await graph.move_item(DRIVE_ID, od_id, sup_id)
        except Exception:
            pass
    return {"ok":True}

# ---- Sync controls + push (optional background uploader) ----
SYNC_PAUSED=False
async def onedrive_push() -> Dict[str,int]:
    if not (graph and DRIVE_ID): return {"uploaded_low":0,"uploaded_hi":0,"notes":0,"moved_superseded":0}
    uploaded_low=uploaded_hi=notes=mv=0
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT id,item_id,kind,IFNULL(onedrive_id,''),IFNULL(superseded,0) FROM photos")
        rows = await cur.fetchall()
    for pid,item_id,kind,od_id,sup in rows:
        # item path
        async with aiosqlite.connect(DB_PATH) as db:
            cur=await db.execute("SELECT path FROM items_cache WHERE id=?",(item_id,)); row=await cur.fetchone()
        if not row: continue
        item_path = row[0] or ""
        try:
            await graph.ensure_folder_path(DRIVE_ID, item_path)
        except Exception:
            continue
        if sup:
            # already local-moved; try ensure Superseded exists; (move might have been done at delete time)
            try:
                await graph.ensure_folder_path(DRIVE_ID, f"{item_path}/Superseded")
            except Exception:
                pass
            mv+=1; continue
        if kind=="LOW":
            fpath=DATA_DIR/'low'/f"{pid}.jpg"
            if fpath.exists():
                data=fpath.read_bytes()
                try:
                    up= await graph.upload_small(DRIVE_ID, f"{item_path}/{pid}.low.jpg", data)
                    uploaded_low+=1
                    async with aiosqlite.connect(DB_PATH) as db:
                        await db.execute("UPDATE photos SET onedrive_id=? WHERE id=?",(up.get("id",""), pid)); await db.commit()
                except Exception:
                    pass
        else:
            fpath=DATA_DIR/'hi'/f"{pid}.jpg"
            if fpath.exists():
                data=fpath.read_bytes()
                try:
                    if len(data) <= 4*1024*1024:
                        up= await graph.upload_small(DRIVE_ID, f"{item_path}/{pid}.hi.jpg", data)
                    else:
                        up= await graph.upload_large(DRIVE_ID, f"{item_path}/{pid}.hi.jpg", data)
                    uploaded_hi+=1
                    async with aiosqlite.connect(DB_PATH) as db:
                        await db.execute("UPDATE photos SET onedrive_id=? WHERE id=?",(up.get("id",""), pid)); await db.commit()
                except Exception:
                    pass
        safe = sanitize(item_id); notes_file = DATA_DIR/'notes'/safe/'NOTES.txt'
        if notes_file.exists():
            try:
                await graph.upload_small(DRIVE_ID, f"{item_path}/NOTES.txt", notes_file.read_bytes())
                notes+=1
            except Exception:
                pass
    return {"uploaded_low":uploaded_low,"uploaded_hi":uploaded_hi,"notes":notes,"moved_superseded":mv}

@app.post("/api/sync/pause")
async def sync_pause(): 
    global SYNC_PAUSED; SYNC_PAUSED=True; return {"ok":True,"paused":True}
@app.post("/api/sync/resume")
async def sync_resume(): 
    global SYNC_PAUSED; SYNC_PAUSED=False; return {"ok":True,"paused":False}
@app.post("/api/sync/push")
async def sync_push():
    if SYNC_PAUSED: return {"ok":False,"paused":True}
    res = await onedrive_push()
    return {"ok":True, **res}
@app.get("/api/sync/status")
async def sync_status():
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT COUNT(1) FROM photos WHERE IFNULL(superseded,0)=0 AND IFNULL(onedrive_id,'')=''"); pending=(await cur.fetchone())[0]
    return {"paused":SYNC_PAUSED,"pending":pending}

# ---- Media ----
@app.get("/media/low/{photo_id}.jpg")
async def media_low(photo_id: str = Path(...)):
    p = DATA_DIR / "low" / f"{photo_id}.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(str(p), media_type="image/jpeg")

@app.get("/media/hi/{photo_id}.jpg")
async def media_hi(photo_id: str = Path(...)):
    p = DATA_DIR / "hi" / f"{photo_id}.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(str(p), media_type="image/jpeg")

# ---- Metrics ----
@app.get("/api/metrics")
async def api_metrics():
    async with aiosqlite.connect(DB_PATH) as db:
        cur=await db.execute("SELECT id,floor,hidden FROM rooms_cache"); rooms=await cur.fetchall()
        floor={}
        for rid,floor_id,hidden in rooms:
            if hidden: continue
            curi=await db.execute("SELECT id,hidden FROM items_cache WHERE room_id=?",(rid,)); items=await curi.fetchall()
            visible=[iid for iid,h in items if h==0] or []
            pass_na=0
            for iid in visible:
                cur2=await db.execute("SELECT status FROM status_events WHERE item_id=? ORDER BY updated_at DESC LIMIT 1",(iid,)); r2=await cur2.fetchone()
                s=r2[0] if r2 else "NA"
                if s in ("PASS","NA"): pass_na+=1
            total=max(len(visible),1); done=1 if pass_na==total else 0
            k=floor_id or "UNK"; floor.setdefault(k,{"rooms":0,"complete":0}); floor[k]["rooms"]+=1; floor[k]["complete"]+=done
    return {"floors":floor,"time":now_iso()}

# ---- Admin APIs ----
@app.post("/api/admin/login")
async def admin_login(request: Request):
    body = await request.json()
    pin = (body or {}).get("pin","")
    if pin != ADMIN_PIN:
        raise HTTPException(401, "bad pin")
    exp = int(time.time()) + 30*60
    tok = _sign(exp)
    resp = JSONResponse({"ok": True, "exp": exp})
    resp.set_cookie("adm", tok, max_age=30*60, path="/", secure=True, httponly=True, samesite="lax")
    return resp

@app.get("/api/admin/room-config/{room_id}")
async def get_room_cfg(room_id: str, request: Request):
    await require_admin(request)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT include_groups, hide_room FROM room_config WHERE room_id=?", (room_id,))
        row = await cur.fetchone()
        cur2 = await db.execute("SELECT hidden FROM rooms_cache WHERE id=?", (room_id,))
        r2 = await cur2.fetchone()
    include_groups = json.loads(row[0]) if row and row[0] else []
    hide_room = bool(row[1]) if row else (bool(r2[0]) if r2 else False)
    return {"includeGroups": include_groups, "HideRoom": hide_room, "hideRoom": hide_room}

@app.post("/api/admin/room-config/{room_id}")
async def set_room_cfg(room_id: str, request: Request):
    await require_admin(request)
    body = await request.json()
    include = body.get("includeGroups", []) or []
    hide_room = bool(body.get("hideRoom", False))
    vis = compute_visible(include)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO room_config(room_id, include_groups, hide_room) VALUES(?,?,?) "
            "ON CONFLICT(room_id) DO UPDATE SET include_groups=excluded.include_groups, hide_room=excluded.hide_room",
            (room_id, json.dumps(include), 1 if hide_room else 0)
        )
        await db.execute("UPDATE rooms_cache SET hidden=? WHERE id=?", (1 if hide_room else 0, room_id))
        # ensure non-removables exist
        for n in NON_REMOVABLE:
            iid=f"{room_id}::{n}"
            await db.execute("INSERT OR IGNORE INTO items_cache(id,room_id,name,path,order_index,hidden,updated_at) VALUES(?,?,?,?,?,?,?)",(iid,room_id,n,"",GLOBAL_ORDER.index(n) if n in GLOBAL_ORDER else 999,0,now_iso()))
        # hide/show based on vis
        cur = await db.execute("SELECT id,name FROM items_cache WHERE room_id=?", (room_id,))
        rows = await cur.fetchall()
        for iid,name in rows:
            hidden = 0 if (name in vis or name in NON_REMOVABLE) else 1
            await db.execute("UPDATE items_cache SET hidden=? WHERE id=?", (hidden, iid))
        await db.commit()
    return {"ok": True, **({"redirect": "/"} if hide_room else {})}

@app.post("/api/admin/rooms/hidden-batch")
async def hidden_batch(request: Request):
    await require_admin(request)
    body = await request.json()
    rooms = body.get("rooms", []) or []
    async with aiosqlite.connect(DB_PATH) as db:
        for r in rooms:
            rid = r.get("id"); hidden = 1 if r.get("hidden") else 0
            if rid:
                await db.execute("UPDATE rooms_cache SET hidden=? WHERE id=?", (hidden, rid))
        await db.commit()
    return {"ok": True}

@app.post("/api/admin/room-clear/{room_id}")
async def admin_room_clear(room_id:str, request: Request):
    await require_admin(request)
    cleared_photos = 0
    # supersede all photos for items in room
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT id FROM items_cache WHERE room_id=?", (room_id,))
        items = [r[0] for r in await cur.fetchall()]
        for iid in items:
            curp = await db.execute("SELECT id,IFNULL(onedrive_id,''),kind FROM photos WHERE item_id=? AND IFNULL(superseded,0)=0",(iid,))
            photos = await curp.fetchall()
            # path for OneDrive
            curpath = await db.execute("SELECT path FROM items_cache WHERE id=?", (iid,)); prow=await curpath.fetchone()
            item_path = (prow[0] if prow else "") or ""
            # local + cloud move
            for pid,od_id,kind in photos:
                for sub in ('low','hi'):
                    src = DATA_DIR/sub/f"{pid}.jpg"
                    if src.exists():
                        outdir = DATA_DIR/'superseded'/sanitize(iid); outdir.mkdir(parents=True, exist_ok=True)
                        try: shutil.move(str(src), str(outdir/f"{pid}.{sub}.jpg"))
                        except Exception: pass
                if graph and DRIVE_ID and od_id and item_path:
                    try:
                        sup = await graph.ensure_folder_path(DRIVE_ID, f"{item_path}/Superseded")
                        supid = sup.get("id","")
                        if supid: await graph.move_item(DRIVE_ID, od_id, supid)
                    except Exception: pass
                cleared_photos += 1
            await db.execute("UPDATE photos SET superseded=1 WHERE item_id=?", (iid,))
            # reset status to NA
            eid=hashlib.sha256(f"{iid}|NA|cleared|{now_iso()}".encode()).hexdigest()
            await db.execute("INSERT OR IGNORE INTO status_events(id,item_id,status,note,updated_at,client_id) VALUES(?,?,?,?,?,?)",(eid,iid,"NA","Cleared by admin",now_iso(),"server"))
            # append marker line to notes (history preserved)
            safe=sanitize(iid); nf=DATA_DIR/'notes'/safe/'NOTES.txt'
            nf.parent.mkdir(parents=True, exist_ok=True)
            with open(nf,"a",encoding="utf-8") as f: f.write(f"{now_iso()} - [CLEARED]\n")
        await db.commit()
    return {"ok":True,"clearedPhotos":cleared_photos}

# ---- SPA routes ----
@app.get("/", response_class=HTMLResponse)
async def index(): return FileResponse(str(STATIC_DIR/'index.html'))
@app.get("/room/{room_id}", response_class=HTMLResponse)
@app.get("/qa/fd/{damper_id}", response_class=HTMLResponse)
@app.get("/admin", response_class=HTMLResponse)
def spa_routes(room_id:Optional[str]=None, damper_id:Optional[str]=None): return FileResponse(str(STATIC_DIR/'index.html'))
