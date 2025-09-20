const $=(q,el=document)=>el.querySelector(q); const $$=(q,el=document)=>Array.from(el.querySelectorAll(q));
(async()=>{ try{ await navigator.serviceWorker.register("/static/sw.js",{scope:"/"}) }catch{} })();

const GLOBAL_ORDER=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed","Ceiling Grid Installed","Ceiling Tile Ready","Ceiling Lined","Rondo Frame Ready","LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested","IBD FD Installed","IBD FD Tested","Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested","VAV Installed","VAV Wired","VCD Actuator Installed","VCD Actuator Wired","VCD Installed"];
const GROUPS={"Ceiling Grid":["Ceiling Grid Installed","Ceiling Tile Ready"],"Lined Ceiling":["Ceiling Lined","Rondo Frame Ready"],"LR Fire Damper":["LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested"],"IBD Fire Damper":["IBD FD Installed","IBD FD Tested"],"VAV":["VAV Installed","VAV Wired"],"VCD":["VCD Actuator Installed","VCD Actuator Wired","VCD Installed"]};
const FD_DEP=["Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested"];
const NON_REMOVABLE=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed"];
const state={ rooms:[], items:new Map(), pinOkUntil:0, currentRoomId:"" };

function fmtPct(a,b){ if(b<=0) return "0%"; return Math.round(100*a/b)+"%"; }
async function j(u){ const r=await fetch(u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function post(u,body){ const r=await fetch(u,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

async function metrics(){
  try{
    const m=await j("/api/metrics"); const g=m.floors?.["N-0"]||{rooms:0,complete:0}; const l1=m.floors?.["N-1"]||{rooms:0,complete:0};
    document.getElementById("ring-ground-val").textContent=fmtPct(g.complete,g.rooms);
    document.getElementById("ring-level1-val").textContent=fmtPct(l1.complete,l1.rooms);
  }catch{ document.getElementById("ring-ground-val").textContent="–%"; document.getElementById("ring-level1-val").textContent="–%"; }
}
setInterval(metrics,12000); metrics();

function mountRooms(rs){
  const wrap=document.getElementById("roomsWrap");
  if(!rs.length){ wrap.innerHTML='<div class="placeholder">No rooms yet – connect Graph or place rooms.json</div>'; return }
  wrap.innerHTML="";
  rs.filter(x=>!x.hidden).forEach(r=>{
    const d=document.createElement("div"); d.className="item";
    d.innerHTML=`<div class="item-h"><div class="item-name">${r.id}</div><button class="btn" data-room="${r.id}">Open</button></div>`;
    wrap.appendChild(d);
  });
  wrap.addEventListener("click",e=>{ const t=e.target; if(t.tagName==="BUTTON" && t.dataset.room){ openRoom(t.dataset.room) } });
}
async function loadRooms(){ try{ state.rooms=await j("/api/rooms"); mountRooms(state.rooms) }catch{ mountRooms([]) } }
function nav(id){ Array.from(document.querySelectorAll(".screen")).forEach(s=>s.classList.remove("active")); document.getElementById(id).classList.add("active"); }
function setupSearch(){
  const i=document.getElementById("search");
  i.addEventListener("input",()=>{ const q=i.value.toLowerCase(); mountRooms(state.rooms.filter(r=> (r.id.toLowerCase().includes(q)||r.name.toLowerCase().includes(q)) && !r.hidden)) })
}

async function openRoom(roomId){
  state.currentRoomId=roomId; document.getElementById("roomTitle").textContent=roomId; nav("room");
  const items=await j(`/api/rooms/${encodeURIComponent(roomId)}/items`);
  items.sort((a,b)=> GLOBAL_ORDER.indexOf(a.name) - GLOBAL_ORDER.indexOf(b.name));
  state.items.set(roomId,items); renderChecklist(roomId);
  import('/static/viewer.js').then(m=>m.setupViewers(roomId)).catch(()=>{});
}
function segHTML(){ return '<div class="seg"><button class="pass">PASS</button><button class="fail">FAIL</button><button class="na">NA</button></div>'; }
function renderChecklist(roomId){
  const items=state.items.get(roomId)||[]; const wrap=document.getElementById("checklist"); wrap.innerHTML="";
  for(const it of items){ if(it.hidden) continue;
    const card=document.createElement("div"); card.className="item"; card.dataset.itemId=it.id;
    card.innerHTML=`
      <div class="item-h"><div class="item-name">${it.name}</div>${segHTML()}</div>
      <div class="note"><textarea placeholder="Note...">${it.note||""}</textarea></div>
      <div class="controls">
        <label class="control"><input type="file" accept="image/*" capture="environment" hidden> 📷 Camera</label>
        <label class="control"><input type="file" accept="image/*" multiple hidden> 🖼️ Gallery</label>
      </div>
      <div class="photo-row"></div>`;
    const seg=card.querySelector(".seg");
    seg.addEventListener("click",async e=>{
      const t=e.target; if(t.tagName!=="BUTTON") return;
      const note=card.querySelector("textarea").value;
      await sendStatus(it.id,t.textContent,note);
      Array.from(seg.querySelectorAll("button")).forEach(b=>b.style.outline=""); t.style.outline="2px solid #8fb3ff";
    });
    const ctrls=card.querySelectorAll("label.control");
    ctrls[0].addEventListener("click",()=>photo(card,it,true));
    ctrls[1].addEventListener("click",()=>photo(card,it,false));
    wrap.appendChild(card);
  }
}
async function sendStatus(itemId,status,note){
  const fd=new FormData(); fd.append("status",status); if(note) fd.append("note",note);
  fd.append("updatedAt",new Date().toISOString()); fd.append("clientId",crypto.randomUUID());
  fetch(`/api/items/${encodeURIComponent(itemId)}/status`,{method:"POST",body:fd}).catch(()=>{});
}
async function photo(card,it,camera){
  const inp=document.createElement("input"); inp.type="file"; inp.accept="image/*"; if(camera) inp.setAttribute("capture","environment"); inp.multiple=true;
  inp.onchange=async ()=>{
    const fs=Array.from(inp.files||[]); if(!fs.length) return; const thumbs=card.querySelector(".photo-row");
    const conn=(navigator.connection||{}); const wifi = conn.effectiveType ? !/2g|slow-2g/.test(conn.effectiveType) : true; const saveData = conn.saveData===true;
    for(const f of fs){
      const blob=await low(f); const url=URL.createObjectURL(blob);
      const d=document.createElement("div"); d.className="thumb"; d.innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:cover">`; thumbs.prepend(d);
      const pid=crypto.randomUUID(); const fd=new FormData();
      fd.append("itemId",it.id); fd.append("photoId",pid); fd.append("createdAt",new Date().toISOString()); fd.append("file",blob,"low.jpg");
      fetch("/api/photos/lowres",{method:"POST",body:fd}).catch(()=>{});
      if(wifi && !saveData){ const fd2=new FormData(); fd2.append("itemId",it.id); fd2.append("photoId",pid); fd2.append("file",f,"hi.jpg"); fetch("/api/photos/hires",{method:"POST",body:fd2}).catch(()=>{}); }
    }
  };
  inp.click();
}
async function low(file){
  const img=new Image(); img.src=URL.createObjectURL(file); await img.decode();
  const max=640; const r=Math.min(max/img.width,max/img.height,1); const w=Math.round(img.width*r),h=Math.round(img.height*r);
  const c=document.createElement("canvas"); c.width=w; c.height=h; const x=c.getContext("2d"); x.drawImage(img,0,0,w,h);
  const b=await new Promise(res=> c.toBlob(b=>res(b),"image/jpeg",0.75)); URL.revokeObjectURL(img.src); return b;
}

function pinOk(){ return Date.now()<state.pinOkUntil }
async function ensurePIN(){
  if(pinOk()) return true;
  const p=prompt("Enter Admin PIN"); if(!p) return false;
  try{ await post('/api/admin/login',{pin:p}); state.pinOkUntil=Date.now()+30*60*1000; return true }catch{ alert("Incorrect PIN"); return false }
}

document.getElementById("pinBtn").addEventListener("click", async ()=>{
  if(!(await ensurePIN())) return;
  const rid=state.currentRoomId;

  // fetch current server state for this room
  let cfg={includeGroups:[], hideRoom:false};
  try{ cfg = await j(`/api/admin/room-config/${encodeURIComponent(rid)}`) }catch{}

  const wrap=document.createElement("div"); wrap.className="item"; wrap.innerHTML='<div class="item-name">Configure Checklist Groups</div>';

  // groups start UNTICKED; tick only those currently enabled per server state
  Object.keys(GROUPS).forEach(g=>{
    const r=document.createElement("label"); r.className="switch";
    const checked = cfg.includeGroups?.includes(g) ? 'checked' : '';
    r.innerHTML=`<input type="checkbox" data-g="${g}" ${checked}> ${g}`;
    wrap.appendChild(r);
  });

  const dep=document.createElement("div"); dep.className="note"; dep.textContent="If LR Fire Damper or IBD Fire Damper is enabled, these are auto-included: "+FD_DEP.join(", ");
  wrap.appendChild(dep);

  const hide=document.createElement("label"); hide.className="switch"; hide.innerHTML=`<input type="checkbox" id="hideRoom" ${cfg.hideRoom?'checked':''}> Hide this room`;
  wrap.appendChild(hide);

  const save=document.createElement("button"); save.className="btn primary"; save.textContent="Save";
  save.onclick=async ()=>{
    const enabled=Array.from(wrap.querySelectorAll('input[data-g]:checked')).map(i=>i.dataset.g);
    const hideRoom = wrap.querySelector('#hideRoom').checked;

    // persist server-side (idempotent)
    try{ await post(`/api/admin/room-config/${encodeURIComponent(rid)}`, { includeGroups: enabled, hideRoom }) }catch(e){ alert("Save failed"); return }

    // reflect immediately in UI
    const visible=new Set(NON_REMOVABLE);
    enabled.forEach(g=> GROUPS[g].forEach(x=>visible.add(x)));
    if(enabled.includes("LR Fire Damper")||enabled.includes("IBD Fire Damper")) FD_DEP.forEach(x=>visible.add(x));
    const items=state.items.get(rid)||[];
    items.forEach(it=>{ it.hidden = (visible.has(it.name)||NON_REMOVABLE.includes(it.name))?0:1; });

    // update room hidden flag locally
    const rm=state.rooms.find(r=>r.id===rid); if(rm){ rm.hidden = hideRoom?1:0 }

    renderChecklist(rid); mountRooms(state.rooms); metrics(); alert("Saved"); wrap.remove();
  };
  wrap.appendChild(save);
  document.getElementById("checklist").prepend(wrap)
});

document.getElementById("adminBtn").addEventListener("click", async ()=>{
  // require pin but don't ask again within session
  if(!(await ensurePIN())) return;
  const list=document.getElementById("hiddenRooms"); list.innerHTML="";
  state.rooms.forEach(r=>{ const row=document.createElement("label"); row.className="switch"; row.innerHTML=`<input type="checkbox" ${(r.hidden? "":"checked")} data-room="${r.id}"> ${r.id}`; list.appendChild(row); });
  document.getElementById("adminSaveHidden").onclick=async ()=>{
    const boxes=Array.from(list.querySelectorAll('input[type=checkbox]'));
    const updates = boxes.map(b=>({ id:b.dataset.room, hidden: b.checked?0:1 })).map(x=>({id:x.id, hidden: x.hidden===1}));
    // Persist
    try{ await post('/api/admin/rooms/hidden-batch', { rooms: updates }) }catch(e){ alert('Save failed'); return }
    // Reflect
    boxes.forEach(b=>{ const rm=state.rooms.find(r=>r.id===b.dataset.room); if(rm) rm.hidden = b.checked?0:1; });
    mountRooms(state.rooms); metrics(); alert("Saved");
  };
  nav("adminPanel");
});

function route(){ const u=new URL(location.href); if(u.pathname.startsWith("/room/")) openRoom(decodeURIComponent(u.pathname.split("/").pop())); else if(u.pathname.startsWith("/admin")) nav("adminPanel"); else nav("dashboard"); }
window.addEventListener("popstate",route);
document.addEventListener("DOMContentLoaded",()=>{ setupSearch(); loadRooms(); route(); });

async function setupSearch(){ const i=document.getElementById("search"); i.addEventListener("input",()=>{ const q=i.value.toLowerCase(); mountRooms(state.rooms.filter(r=> (r.id.toLowerCase().includes(q)||r.name.toLowerCase().includes(q)) && !r.hidden)) }) }
async function low(file){ const img=new Image(); img.src=URL.createObjectURL(file); await img.decode(); const max=640; const r=Math.min(max/img.width,max/img.height,1); const w=Math.round(img.width*r),h=Math.round(img.height*r); const c=document.createElement("canvas"); c.width=w; c.height=h; const x=c.getContext("2d"); x.drawImage(img,0,0,w,h); const b=await new Promise(res=> c.toBlob(b=>res(b),"image/jpeg",0.75)); URL.revokeObjectURL(img.src); return b; }
