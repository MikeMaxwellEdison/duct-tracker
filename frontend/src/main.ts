const $ = (q:string, el:Document|HTMLElement=document)=> el.querySelector(q) as HTMLElement
const $$ = (q:string, el:Document|HTMLElement=document)=> Array.from(el.querySelectorAll(q)) as HTMLElement[]

async function registerSW(){ try{ await navigator.serviceWorker.register("/static/sw.js",{scope:"/"}) }catch{} }
registerSW()

type Room={id:string,name:string,path:string,floor:string,updatedAt:string,hidden:number}
type Item={id:string,roomId:string,name:string,path:string,orderIndex:number,hidden:number,updatedAt:string,status?:string,note?:string}

const GLOBAL_ORDER=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed","Ceiling Grid Installed","Ceiling Tile Ready","Ceiling Lined","Rondo Frame Ready","LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested","IBD FD Installed","IBD FD Tested","Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested","VAV Installed","VAV Wired","VCD Actuator Installed","VCD Actuator Wired","VCD Installed"]
const GROUPS:{[k:string]:string[]}={"Ceiling Grid":["Ceiling Grid Installed","Ceiling Tile Ready"],"Lined Ceiling":["Ceiling Lined","Rondo Frame Ready"],"LR Fire Damper":["LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested"],"IBD Fire Damper":["IBD FD Installed","IBD FD Tested"],"VAV":["VAV Installed","VAV Wired"],"VCD":["VCD Actuator Installed","VCD Actuator Wired","VCD Installed"]}
const FD_DEP=["Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested"]
const NON_REMOVABLE=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed"]

const state={ rooms:[] as Room[], items:new Map<string,Item[]>(), pinOkUntil:0, currentRoomId:"" }
function fmtPct(a:number,b:number){ if(b<=0) return "0%"; return Math.round(100*a/b)+"%" }
async function j<T>(u:string){ const r=await fetch(u); return r.json() }

async function metrics(){
 try{ const m=await j<{floors:any}>("/api/metrics"); const g=m.floors["N-0"]||{rooms:0,complete:0}; const l1=m.floors["N-1"]||{rooms:0,complete:0}
  (document.getElementById("ring-ground-val")!).textContent=fmtPct(g.complete,g.rooms)
  (document.getElementById("ring-level1-val")!).textContent=fmtPct(l1.complete,l1.rooms)
 }catch{
  (document.getElementById("ring-ground-val")!).textContent="â€“%"; (document.getElementById("ring-level1-val")!).textContent="â€“%"
 }
}
setInterval(metrics,12000); metrics()

function mountRooms(rs:Room[]){
  const wrap=document.getElementById("roomsWrap")!
  if(!rs.length){ wrap.innerHTML=`<div class="placeholder">No rooms yet â€“ connect Graph or place rooms.json</div>`; return }
  wrap.innerHTML=""
  for(const r of rs.filter(x=>!x.hidden)){
    const d=document.createElement("div"); d.className="item"
    d.innerHTML=`<div class="item-h"><div class="item-name">${r.id}</div><button class="btn" data-room="${r.id}">Open</button></div>`
    wrap.appendChild(d)
  }
  wrap.addEventListener("click",(e)=>{
    const t=e.target as HTMLElement
    if(t.tagName==="BUTTON" && (t as any).dataset.room){ openRoom((t as any).dataset.room!) }
  })
}
async function loadRooms(){ try{ state.rooms=await j<Room[]>("/api/rooms"); mountRooms(state.rooms) }catch{ mountRooms([]) } }
function nav(id:string){
  Array.from(document.querySelectorAll(".screen")).forEach(s=> (s as HTMLElement).classList.remove("active"))
  document.getElementById(id)!.classList.add("active")
}
function setupSearch(){
  const i=document.getElementById("search") as HTMLInputElement
  i.addEventListener("input",()=>{
    const q=i.value.toLowerCase()
    mountRooms(state.rooms.filter(r=> (r.id.toLowerCase().includes(q)||r.name.toLowerCase().includes(q)) && !r.hidden))
  })
}

async function openRoom(roomId:string){
  state.currentRoomId=roomId
  document.getElementById("roomTitle")!.textContent=roomId
  nav("room")
  const items=await j<Item[]>(`/api/rooms/${encodeURIComponent(roomId)}/items`)
  items.sort((a,b)=> GLOBAL_ORDER.indexOf(a.name) - GLOBAL_ORDER.indexOf(b.name))
  state.items.set(roomId,items)
  renderChecklist(roomId)
  import("./viewer").then(m=> m.setupViewers(roomId))
}
function segHTML(){ return `<div class="seg"><button class="pass">PASS</button><button class="fail">FAIL</button><button class="na">NA</button></div>` }
function renderChecklist(roomId:string){
  const items=state.items.get(roomId)||[]
  const wrap=document.getElementById("checklist")!; wrap.innerHTML=""
  for(const it of items){
    if(it.hidden) continue
    const card=document.createElement("div"); card.className="item"; (card as any).dataset.itemId=it.id
    card.innerHTML=`
      <div class="item-h"><div class="item-name">${it.name}</div>${segHTML()}</div>
      <div class="note"><textarea placeholder="Note...">${it.note||""}</textarea></div>
      <div class="controls">
        <label class="control"><input type="file" accept="image/*" capture="environment" hidden> ðŸ“· Camera</label>
        <label class="control"><input type="file" accept="image/*" multiple hidden> ðŸ–¼ï¸ Gallery</label>
      </div>
      <div class="photo-row"></div>
    `
    const seg=card.querySelector(".seg")!
    seg.addEventListener("click", async (e)=>{
      const t=e.target as HTMLButtonElement
      if(t.tagName!=="BUTTON") return
      const note=(card.querySelector("textarea") as HTMLTextAreaElement).value
      await sendStatus(it.id, t.textContent!, note)
      Array.from(seg.querySelectorAll("button")).forEach((b:any)=> b.style.outline="")
      t.style.outline="2px solid #8fb3ff"
    })
    const ctrls=card.querySelectorAll("label.control")
    ;(ctrls[0] as HTMLElement).addEventListener("click",()=>photo(card,it,true))
    ;(ctrls[1] as HTMLElement).addEventListener("click",()=>photo(card,it,false))
    wrap.appendChild(card)
  }
}
async function sendStatus(itemId:string,status:string,note:string){
  const fd=new FormData()
  fd.append("status",status); if(note) fd.append("note",note)
  fd.append("updatedAt", new Date().toISOString()); fd.append("clientId", crypto.randomUUID())
  fetch(`/api/items/${encodeURIComponent(itemId)}/status`, { method:"POST", body:fd }).catch(()=>{})
}
async function photo(card:HTMLElement,it:Item,camera:boolean){
  const inp=document.createElement("input"); inp.type="file"; inp.accept="image/*"; if(camera) (inp as any).capture="environment"; inp.multiple=true
  inp.onchange=async ()=>{
    const fs=Array.from(inp.files||[]); if(!fs.length) return
    const thumbs=card.querySelector(".photo-row")!
    const wifi=(navigator as any).connection?.effectiveType ? !/2g|slow-2g/.test((navigator as any).connection.effectiveType):true
    const saveData=(navigator as any).connection?.saveData===true
    for(const f of fs){
      const blob=await low(f); const url=URL.createObjectURL(blob)
      const d=document.createElement("div"); d.className="thumb"; d.innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:cover">`
      thumbs.prepend(d)
      const pid=crypto.randomUUID()
      const fd=new FormData(); fd.append("itemId",it.id); fd.append("photoId",pid); fd.append("createdAt", new Date().toISOString()); fd.append("file",blob,"low.jpg")
      fetch("/api/photos/lowres",{method:"POST",body:fd}).catch(()=>{})
      if(wifi && !saveData){
        const fd2=new FormData(); fd2.append("itemId",it.id); fd2.append("photoId",pid); fd2.append("file",f,"hi.jpg")
        fetch("/api/photos/hires",{method:"POST",body:fd2}).catch(()=>{})
      }
    }
  }
  inp.click()
}
async function low(file:File){
  const img=new Image(); img.src=URL.createObjectURL(file); await img.decode()
  const max=640; const r=Math.min(max/img.width,max/img.height,1); const w=Math.round(img.width*r),h=Math.round(img.height*r)
  const c=document.createElement("canvas"); c.width=w; c.height=h; const x=c.getContext("2d")!; x.drawImage(img,0,0,w,h)
  const b=await new Promise<Blob>(res=> c.toBlob(b=>res(b!), "image/jpeg", 0.75))
  URL.revokeObjectURL(img.src); return b
}
function pinOk(){ return Date.now()<state.pinOkUntil }
async function ensurePIN(){ if(pinOk()) return true; const p=prompt("Enter Admin PIN"); if(!p) return false; state.pinOkUntil=Date.now()+30*60*1000; return true }
document.getElementById("pinBtn")!.addEventListener("click", async ()=>{
  if(!(await ensurePIN())) return
  const rid=state.currentRoomId
  const wrap=document.createElement("div"); wrap.className="item"; wrap.innerHTML=`<div class="item-name">Configure Checklist Groups</div>`
  for(const g of Object.keys(GROUPS)){ const r=document.createElement("label"); r.className="switch"; r.innerHTML=`<input type="checkbox" data-g="${g}"> ${g}`; wrap.appendChild(r) }
  const dep=document.createElement("div"); dep.className="note"; dep.textContent="If LR Fire Damper or IBD Fire Damper is enabled, these are auto-included: "+FD_DEP.join(", ")
  wrap.appendChild(dep)
  const hide=document.createElement("label"); hide.className="switch"; hide.innerHTML=`<input type="checkbox" id="hideRoom"> Hide this room`
  wrap.appendChild(hide)
  const save=document.createElement("button"); save.className="btn primary"; save.textContent="Save"
  save.onclick=()=>{
    const enabled=Array.from(wrap.querySelectorAll('input[data-g]:checked')).map(i=>(i as HTMLInputElement).dataset.g!)
    const visible=new Set<string>(NON_REMOVABLE)
    for(const g of enabled){ GROUPS[g].forEach(x=>visible.add(x)) }
    if(enabled.includes("LR Fire Damper")||enabled.includes("IBD Fire Damper")) FD_DEP.forEach(x=>visible.add(x))
    const items=state.items.get(rid)||[]
    for(const it of items){ it.hidden = (visible.has(it.name)||NON_REMOVABLE.includes(it.name))?0:1 }
    renderChecklist(rid); alert("Saved"); wrap.remove()
  }
  wrap.appendChild(save)
  document.getElementById("checklist")!.prepend(wrap)
})
document.getElementById("adminBtn")!.addEventListener("click", ()=>{
  const list=document.getElementById("hiddenRooms")!; list.innerHTML=""
  for(const r of state.rooms){ const row=document.createElement("label"); row.className="switch"; row.innerHTML=`<input type="checkbox" ${(r.hidden? "":"checked")} data-room="${r.id}"> ${r.id}`; list.appendChild(row) }
  ;(document.getElementById("adminSaveHidden") as HTMLButtonElement).onclick=()=>{
    const boxes=Array.from(list.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[]
    for(const b of boxes){ const rm=state.rooms.find(x=>x.id===b.dataset.room)!; rm.hidden=b.checked?0:1 }
    mountRooms(state.rooms); alert("Saved")
  }
  nav("adminPanel")
})
function route(){
  const u=new URL(location.href)
  if(u.pathname.startsWith("/room/")){ openRoom(decodeURIComponent(u.pathname.split("/").pop()!)) }
  else if(u.pathname.startsWith("/admin")){ nav("adminPanel") }
  else { nav("dashboard") }
}
window.addEventListener("popstate",route)
document.addEventListener("DOMContentLoaded",()=>{ setupSearch(); loadRooms(); route() })