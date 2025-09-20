export function setupViewers(roomId:string){
  const v=document.getElementById("viewer")!, fr=document.getElementById("fr-viewer")!
  ;[v,fr].forEach(el=>{
    el.innerHTML=`<div class="placeholder">No tiles yet</div>`;
    el.addEventListener("dblclick",()=>{
      const t=document.createElement("div"); t.className="toast small"; t.textContent="Double Tap received";
      el.appendChild(t); setTimeout(()=>t.remove(),1200)
    })
  })
  const level=(roomId||"").includes("N-1")?"AN1.025":"AN1.020"
  fetch(`/static/indices/${level}.json`).then(r=>r.ok?r.json():null).then(idx=>{
    if(!idx){ const t=document.getElementById("fr-toast")!; t.hidden=false; return }
    const f=idx.rooms?.find((x:any)=>x.id===roomId); if(!f){ const t=document.getElementById("fr-toast")!; t.hidden=false; return }
    fr.innerHTML = `<div class="placeholder">Auto-zoomed ${level}</div>`
  }).catch(()=>{ const t=document.getElementById("fr-toast")!; t.hidden=false })
}