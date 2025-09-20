(function(){
  function $(q,el){ return (el||document).querySelector(q) }
  function $all(q,el){ return Array.prototype.slice.call((el||document).querySelectorAll(q)) }
  function uuid(){ try{ return crypto.randomUUID() }catch(e){ return "u"+Date.now().toString(36)+Math.random().toString(36).slice(2) } }
  function setChip(txt){ var c=$("#syncChip"); if(c) c.textContent = "Sync: " + txt }

  var GLOBAL_ORDER=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed","Ceiling Grid Installed","Ceiling Tile Ready","Ceiling Lined","Rondo Frame Ready","LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested","IBD FD Installed","IBD FD Tested","Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested","VAV Installed","VAV Wired","VCD Actuator Installed","VCD Actuator Wired","VCD Installed"];
  var GROUPS={"Ceiling Grid":["Ceiling Grid Installed","Ceiling Tile Ready"],"Lined Ceiling":["Ceiling Lined","Rondo Frame Ready"],"LR Fire Damper":["LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested"],"IBD Fire Damper":["IBD FD Installed","IBD FD Tested"],"VAV":["VAV Installed","VAV Wired"],"VCD":["VCD Actuator Installed","VCD Actuator Wired","VCD Installed"]};
  var FD_DEP=["Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested"];
  var NON_REMOVABLE=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed"];
  var state={ rooms:[], items:new Map(), notes:new Map(), pinOkUntil:0, currentRoomId:"", camera:{stream:null,count:0,active:false,targets:[],idx:0}, lb:{nodes:[],idx:0,container:null}, idleTimer:null, syncPaused:false };

  if("serviceWorker" in navigator){ navigator.serviceWorker.register("/static/sw.js",{scope:"/"}).catch(function(){}) }

  function setRing(el, pct){ pct=Math.max(0,Math.min(100,Math.round(pct||0))); if(!el) return; el.style.background="conic-gradient(var(--good) "+pct+"%, #1a2e4f 0)"; var v=el.querySelector(".ring-val"); if(v) v.textContent=pct+"%" }
  function fmtPct(a,b){ if(!b||b<=0) return 0; return Math.round(100*a/b) }
  function metrics(){ fetch("/api/metrics").then(r=>r.json()).then(m=>{ var f=m.floors||{}; var g=f["N-0"]||{rooms:0,complete:0}, l1=f["N-1"]||{rooms:0,complete:0}; setRing($("#ring-ground"),fmtPct(g.complete,g.rooms)); setRing($("#ring-level1"),fmtPct(l1.complete,l1.rooms)); }).catch(()=>{ setRing($("#ring-ground"),0); setRing($("#ring-level1"),0) }) }

  function j(u){ return fetch(u).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  function post(u,b){ return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }

  function bumpIdle(){ if(state.syncPaused) return; if(state.idleTimer) clearTimeout(state.idleTimer); state.idleTimer=setTimeout(pushSync, 3000) }
  function pauseSync(){ state.syncPaused=true; setChip("paused"); post("/api/sync/pause",{}).catch(()=>{}) }
  function resumeSync(){ state.syncPaused=false; setChip("idle"); post("/api/sync/resume",{}).catch(()=>{}); bumpIdle() }
  function pushSync(){ setChip("pushing..."); post("/api/sync/push",{}).then(()=>{ setChip("idle") }).catch(()=>{ setChip("error") }) }
  $("#syncChip").addEventListener("click", function(){ pushSync() })

  function mountRooms(rs){
    var wrap=$("#roomsWrap");
    if(!rs || !rs.length){ wrap.innerHTML='<div class="placeholder">No rooms yet – connect Graph or place rooms.json</div>'; return }
    wrap.innerHTML="";
    rs.forEach(function(r){
      if(r.hidden) return;
      var d=document.createElement("div"); d.className="item";
      d.innerHTML='<div class="item-h"><div class="item-name">'+r.id+'</div><button class="btn" data-room="'+r.id+'">Open</button></div>';
      wrap.appendChild(d);
    });
    wrap.onclick=function(e){ var t=e.target; if(t && t.tagName==="BUTTON" && t.getAttribute("data-room")){ openRoom(t.getAttribute("data-room")) } }
  }
  function loadRooms(){ j("/api/rooms").then(rs=>{ state.rooms=rs||[]; mountRooms(state.rooms) }).catch(()=>{ mountRooms([]) }) }

  function nav(id){ $all(".screen").forEach(s=>s.classList.remove("active")); var el=document.getElementById(id); if(el) el.classList.add("active") }
  function push(path){ try{ history.pushState({path:path},"",path) }catch(e){} }
  function route(){ var p=location.pathname||"/"; if(p.indexOf("/room/")===0){ openRoom(decodeURIComponent(p.slice(6)),true); return } if(p.indexOf("/admin")===0){ nav("adminPanel"); return } nav("dashboard") }
  window.addEventListener("popstate", route);

  function pinOk(){ return Date.now()<state.pinOkUntil }
  function ensurePIN(){ if(pinOk()) return Promise.resolve(true); var p=prompt("Enter Admin PIN"); if(!p) return Promise.resolve(false); return post("/api/admin/login",{pin:p}).then(()=>{ state.pinOkUntil=Date.now()+30*60*1000; return true }).catch(()=>{ alert("Incorrect PIN"); return false }) }

  function segHTML(sel){ return '<div class="seg">'+
    '<button class="pass'+(sel==="PASS"?' selected':'')+'">PASS</button>'+
    '<button class="fail'+(sel==="FAIL"?' selected':'')+'">FAIL</button>'+
    '<button class="na'+(sel==="NA"?' selected':'')+'">NA</button></div>' }

  function renderChecklist(roomId){
    var items=state.items.get(roomId)||[]; var wrap=$("#checklist"); if(!wrap) return; wrap.innerHTML="";
    items.forEach(function(it){
      if(it.hidden) return;
      var noteVal = state.notes.has(it.id) ? state.notes.get(it.id) : (it.note||"");
      var card=document.createElement("div"); card.className="item"; card.setAttribute("data-item-id", it.id);
      card.innerHTML=
        '<div class="item-h"><div class="item-name">'+it.name+'</div>'+segHTML(it.status||"NA")+'</div>'+
        '<div class="note"><textarea placeholder="Note...">'+(noteVal||"")+'</textarea></div>'+
        '<div class="controls">'+
          '<button class="btn" data-cam="'+it.id+'">📷 Camera</button>'+
          '<label class="control"><input type="file" accept="image/*" multiple hidden> 🖼️ Gallery</label>'+
        '</div>'+
        '<div class="photo-row"></div>';
      var seg=card.querySelector(".seg");
      seg.addEventListener("click",function(e){
        var t=e.target; if(!t||t.tagName!=="BUTTON") return;
        var val=t.classList.contains("pass")?"PASS":t.classList.contains("fail")?"FAIL":"NA";
        $all("button",seg).forEach(b=>b.classList.remove("selected")); t.classList.add("selected");
        var note=card.querySelector("textarea").value; state.notes.set(it.id,note);
        sendStatus(it.id,val,note);
        if(it.name.indexOf("FD Tested")>=0 && val==="FAIL"){
          var rid = prompt("Enter linked room ID for FD HOLD (e.g. N-0.123). Leave blank to skip.");
          if(rid){ post("/api/fd/hold",{itemId:it.id, linkedRoomId:rid}).then(()=>alert("FD hold linked")).catch(()=>alert("FD hold failed")) }
        }
      });
      var ta=card.querySelector("textarea");
      ta.addEventListener("keydown",function(ev){ if(ev.key==="Enter" && !ev.shiftKey){ ev.preventDefault(); state.notes.set(it.id, ta.value); post("/api/items/"+encodeURIComponent(it.id)+"/note",{text:ta.value}).finally(bumpIdle) }});
      ta.addEventListener("blur", function(){ if(ta.value && ta.value.trim()){ state.notes.set(it.id, ta.value); post("/api/items/"+encodeURIComponent(it.id)+"/note",{text:ta.value}).finally(bumpIdle) } });

      card.querySelector('[data-cam]').addEventListener("click", function(){ openCameraSession(it, card) });
      var gal=card.querySelector('label.control input[type=file]');
      gal.addEventListener("change", function(){ var files=Array.prototype.slice.call(gal.files||[]); if(!files.length) return; handleFiles(it, card, files) });

      wrap.appendChild(card);
      loadPhotos(it, card);
    });
  }

  function openRoom(roomId, fromRoute){
    state.currentRoomId=roomId; var t=$("#roomTitle"); if(t) t.textContent=roomId;
    if(!fromRoute){ push("/room/"+encodeURIComponent(roomId)) }
    nav("room");
    j("/api/rooms/"+encodeURIComponent(roomId)+"/items").then(items=>{
      items=items||[]; items.sort((a,b)=>GLOBAL_ORDER.indexOf(a.name)-GLOBAL_ORDER.indexOf(b.name));
      state.items.set(roomId, items); renderChecklist(roomId);
      if(window.setupViewers) try{ window.setupViewers(roomId) }catch(e){}
    }).catch(()=>{ state.items.set(roomId, []); renderChecklist(roomId) })
  }

  function sendStatus(itemId,status,note){
    var fd=new FormData(); fd.append("status",status||""); if(note) fd.append("note",note); fd.append("updatedAt", new Date().toISOString()); fd.append("clientId", uuid());
    fetch("/api/items/"+encodeURIComponent(itemId)+"/status",{method:"POST",body:fd}).finally(bumpIdle)
  }

  function low(file){ return new Promise(function(resolve){ var img=new Image(); img.onload=function(){ var max=640; var r=Math.min(max/img.naturalWidth,max/img.naturalHeight,1); var w=Math.round(img.naturalWidth*r),h=Math.round(img.naturalHeight*r); var c=document.createElement("canvas"); c.width=w; c.height=h; c.getContext("2d").drawImage(img,0,0,w,h); c.toBlob(function(b){ resolve(b) },"image/jpeg",0.75) }; img.src=URL.createObjectURL(file) }) }

  function handleFiles(it, card, files){
    var thumbs = card.querySelector(".photo-row");
    var con = navigator.connection||{}; var wifi = con.effectiveType ? !/2g|slow-2g/.test(con.effectiveType) : true; var saveData = con.saveData===true;
    pauseSync();
    files.forEach(function(f){
      low(f).then(function(blob){
        var pid=uuid(); var thumbUrl=URL.createObjectURL(blob);
        addThumb(thumbs, pid, thumbUrl, "/media/low/"+pid+".jpg", it.id);
        var fd=new FormData(); fd.append("itemId",it.id); fd.append("photoId",pid); fd.append("createdAt", new Date().toISOString()); fd.append("file",blob,"low.jpg");
        fetch("/api/photos/lowres",{method:"POST",body:fd}).finally(bumpIdle);
        if(wifi && !saveData){ var fd2=new FormData(); fd2.append("itemId",it.id); fd2.append("photoId",pid); fd2.append("file",f,"hi.jpg"); fetch("/api/photos/hires",{method:"POST",body:fd2}).finally(bumpIdle) }
      });
    });
    setTimeout(resumeSync, 600);
  }
  function loadPhotos(it, card){
    j("/api/items/"+encodeURIComponent(it.id)+"/photos").then(list=>{
      var thumbs=card.querySelector(".photo-row"); if(!thumbs) return;
      list.forEach(function(p){ var href=(p.kind==="HI")?("/media/hi/"+p.id+".jpg"):("/media/low/"+p.id+".jpg"); addThumb(thumbs, p.id, href, href, it.id) });
    }).catch(()=>{});
  }
  function addThumb(container, id, src, href, itemId){
    var d=document.createElement("div"); d.className="thumb"; d.innerHTML='<img src="'+src+'" data-href="'+href+'" data-id="'+id+'" data-item="'+itemId+'" alt="photo">';
    d.addEventListener("click", function(){
      var imgs = Array.prototype.slice.call(container.querySelectorAll("img"));
      state.lb.nodes = imgs; state.lb.container = container;
      state.lb.idx = imgs.findIndex(n=>n.dataset.id===id);
      openLightboxAt(state.lb.idx);
    });
    container.insertBefore(d, container.firstChild);
  }

  function openLightboxAt(i){
    if(!state.lb.nodes || !state.lb.nodes.length) return;
    state.lb.idx = Math.max(0, Math.min(state.lb.nodes.length-1, i));
    var n = state.lb.nodes[state.lb.idx];
    $("#lightboxImg").src = n.dataset.href;
    $("#lightboxImg").setAttribute("data-id", n.dataset.id);
    $("#lightboxImg").setAttribute("data-item", n.dataset.item);
    $("#lightbox").hidden=false; pauseSync();
  }
  function lbPrev(){ if(state.lb.idx>0) openLightboxAt(state.lb.idx-1) }
  function lbNext(){ if(state.lb.idx<state.lb.nodes.length-1) openLightboxAt(state.lb.idx+1) }
  function lbClose(){ $("#lightbox").hidden=true; $("#lightboxImg").src=""; resumeSync() }
  $("#lbPrev").addEventListener("click", lbPrev);
  $("#lbNext").addEventListener("click", lbNext);
  $("#lightboxClose").addEventListener("click", lbClose);
  (function(){ var sx=0, sy=0; $("#lightbox").addEventListener("touchstart", function(e){ if(!e.touches[0]) return; sx=e.touches[0].clientX; sy=e.touches[0].clientY }, {passive:true});
    $("#lightbox").addEventListener("touchend", function(e){ var t=e.changedTouches&&e.changedTouches[0]; if(!t) return; var dx=t.clientX-sx, dy=t.clientY-sy; if(Math.abs(dx)>50 && Math.abs(dy)<40){ if(dx<0) lbNext(); else lbPrev(); } }, {passive:true}) })();
  $("#lightboxDelete").addEventListener("click", function(){
    var id=$("#lightboxImg").getAttribute("data-id"); var item=$("#lightboxImg").getAttribute("data-item");
    if(!id) return;
    var cont = state.lb.container;
    post("/api/photos/"+encodeURIComponent(id)+"/supersede",{itemId:item}).then(function(){
      var thumb = cont.querySelector('img[data-id="'+CSS.escape(id)+'"]');
      if(thumb && thumb.parentElement) thumb.parentElement.remove();
      state.lb.nodes = Array.prototype.slice.call(cont.querySelectorAll("img"));
      if(!state.lb.nodes.length){ lbClose(); return }
      if(state.lb.idx >= state.lb.nodes.length) state.lb.idx = state.lb.nodes.length-1;
      openLightboxAt(state.lb.idx);
      bumpIdle();
    }).catch(()=>{ alert("Delete failed") });
  });

  function openCameraSession(it, card){
    var modal=$("#camModal"), v=$("#camVideo"), shutter=$("#camShutter"), done=$("#camDone"), count=$("#camCount"), name=$("#camItemName");
    var prevBtn=$("#camPrev"), nextBtn=$("#camNext");
    state.camera.targets = (state.items.get(state.currentRoomId)||[]).filter(x=>!x.hidden);
    state.camera.idx = state.camera.targets.findIndex(x=>x.id===it.id);
    function setTarget(i){
      state.camera.idx = Math.max(0, Math.min(state.camera.targets.length-1, i));
      it = state.camera.targets[state.camera.idx];
      card = document.querySelector('[data-item-id="'+CSS.escape(it.id)+'"]'); if(card) card=card.closest(".item");
      state.camera.count = 0; count.textContent="0/10"; name.textContent = it.name;
    }
    setTarget(state.camera.idx<0?0:state.camera.idx);
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      var inp=document.createElement("input"); inp.type="file"; inp.accept="image/*"; inp.multiple=true; inp.setAttribute("capture","environment");
      inp.onchange=function(){ var files=Array.prototype.slice.call(inp.files||[]); if(!files.length) return; handleFiles(it, card, files) };
      inp.click(); return;
    }
    pauseSync(); modal.hidden=false; state.camera.active=true;
    navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}}).then(function(stream){ state.camera.stream=stream; v.srcObject=stream })
    .catch(function(){ modal.hidden=true; state.camera.active=false; resumeSync() });
    function take(){
      if(!state.camera.active || state.camera.count>=10) return;
      var c=document.createElement("canvas"); var w=v.videoWidth||800, h=v.videoHeight||600; c.width=w; c.height=h; c.getContext("2d").drawImage(v,0,0,w,h);
      c.toBlob(function(blob){ state.camera.count++; count.textContent=state.camera.count+"/10"; handleFiles(it, card, [new File([blob],"cam.jpg",{type:"image/jpeg"})]) },"image/jpeg",0.85);
    }
    shutter.onclick=take;
    done.onclick=function(){ try{ state.camera.stream.getTracks().forEach(t=>t.stop()) }catch(e){} modal.hidden=true; state.camera.active=false; resumeSync() };
    prevBtn.onclick=function(){ setTarget(state.camera.idx-1) };
    nextBtn.onclick=function(){ setTarget(state.camera.idx+1) };
  }

  function wireAdminPanel(){
    var btn=$("#adminBtn"); if(!btn) return;
    btn.addEventListener("click", function(){ ensurePIN().then(function(ok){ if(!ok) return;
      var list=$("#hiddenRooms"); if(list) list.innerHTML="";
      var hidden=(state.rooms||[]).filter(r=>!!r.hidden);
      if(!hidden.length){ list.innerHTML='<div class="placeholder">No hidden rooms</div>'; }
      hidden.forEach(function(r){ var row=document.createElement("label"); row.className="switch"; row.innerHTML='<input type="checkbox" '+(r.hidden? "" : "checked")+' data-room="'+r.id+'"> '+r.id; list.appendChild(row) });
      $("#adminSaveHidden").onclick=function(){
        var boxes=$all("#hiddenRooms input[type=checkbox]");
        var updates = boxes.map(function(b){ return { id:b.getAttribute("data-room"), hidden: !b.checked } });
        post("/api/admin/rooms/hidden-batch", { rooms: updates }).then(function(){
          boxes.forEach(function(b){ var rm=(state.rooms||[]).find(x=>x.id===b.getAttribute("data-room")); if(rm) rm.hidden = !b.checked; });
          mountRooms(state.rooms); metrics(); alert("Saved");
        }).catch(function(){ alert("Save failed") });
      };
      push("/admin"); nav("adminPanel");
    }) })
  }

  function wireRoomAdmin(){
    var pinBtn=$("#pinBtn"); if(!pinBtn) return;
    pinBtn.addEventListener("click", function(){
      ensurePIN().then(function(ok){ if(!ok) return;
        var rid=state.currentRoomId;
        var existing=$("#admin-config"); if(existing){ try{ existing.remove() }catch(e){} }
        j("/api/admin/room-config/"+encodeURIComponent(rid)).then(function(cfg){
          cfg = cfg || {includeGroups:[], hideRoom:false};
          var wrap=document.createElement("div"); wrap.id="admin-config"; wrap.className="item"; wrap.innerHTML='<div class="item-name">Configure Checklist Groups</div>';
          Object.keys(GROUPS).forEach(function(g){
            var lab=document.createElement("label"); lab.className="switch";
            var checked = (cfg.includeGroups||[]).indexOf(g)>=0 ? "checked" : "";
            lab.innerHTML='<input type="checkbox" data-g="'+g+'" '+checked+'> '+g;
            wrap.appendChild(lab);
          });
          var dep=document.createElement("div"); dep.className="note"; dep.textContent="If LR Fire Damper or IBD Fire Damper is enabled, these are auto-included: "+FD_DEP.join(", "); wrap.appendChild(dep);
          var hide=document.createElement("label"); hide.className="switch"; hide.innerHTML='<input type="checkbox" id="hideRoom" '+(cfg.hideRoom?'checked':'')+'> Hide this room'; wrap.appendChild(hide);
          var btnRow=document.createElement("div"); btnRow.style.display="flex"; btnRow.style.gap="8px"; btnRow.style.marginTop="8px";
          var save=document.createElement("button"); save.className="btn primary"; save.textContent="Save";
          var clear=document.createElement("button"); clear.className="btn"; clear.textContent="Clear Room";
          btnRow.appendChild(save); btnRow.appendChild(clear); wrap.appendChild(btnRow);

          save.onclick=function(){
            var enabled=$all('input[data-g]:checked', wrap).map(i=>i.getAttribute("data-g"));
            var hideRoom = !!($('#hideRoom', wrap).checked);
            post("/api/admin/room-config/"+encodeURIComponent(rid), { includeGroups: enabled, hideRoom: hideRoom }).then(function(resp){
              // Apply immediate UI: ensure non-removables exist
              var visible={}; NON_REMOVABLE.forEach(n=>visible[n]=true);
              enabled.forEach(function(g){ (GROUPS[g]||[]).forEach(function(n){ visible[n]=true }) });
              if(enabled.indexOf("LR Fire Damper")>=0 || enabled.indexOf("IBD Fire Damper")>=0){ FD_DEP.forEach(function(n){ visible[n]=true }) }
              var items = state.items.get(rid) || [];
              var nameSet = new Set(items.map(i=>i.name));
              NON_REMOVABLE.forEach(function(n){
                if(!nameSet.has(n)){
                  items.push({id:rid+"::"+n,roomId:rid,name:n,path:"",orderIndex:GLOBAL_ORDER.indexOf(n),hidden: visible[n]?0:1, status:"NA", note:""});
                }
              });
              items.forEach(function(it){ it.hidden = visible[it.name] ? 0 : 1 });
              items.sort(function(a,b){ return GLOBAL_ORDER.indexOf(a.name)-GLOBAL_ORDER.indexOf(b.name) });
              state.items.set(rid, items);
              var rm=(state.rooms||[]).find(r=>r.id===rid); if(rm){ rm.hidden = hideRoom?1:0 }
              if(resp && resp.redirect==="/"){ push("/"); nav("dashboard"); loadRooms() } else { renderChecklist(rid); mountRooms(state.rooms) }
              metrics(); alert("Saved"); try{ wrap.remove() }catch(e){}
            }).catch(function(){ alert("Save failed") });
          };

          clear.onclick=function(){
            if(!confirm("Clear this room? All photos will be superseded and notes cleared from the page (history retained in NOTES.txt).")) return;
            post("/api/admin/room-clear/"+encodeURIComponent(rid),{}).then(function(){
              // Reset UI
              var items = state.items.get(rid)||[];
              items.forEach(function(it){
                it.status="NA";
                var card=document.querySelector('[data-item-id="'+CSS.escape(it.id)+'"]');
                if(card){
                  var seg=card.querySelector(".seg"); if(seg){ $all("button",seg).forEach(b=>b.classList.remove("selected")); seg.querySelector(".na").classList.add("selected") }
                  var pr=card.querySelector(".photo-row"); if(pr) pr.innerHTML="";
                  var ta=card.querySelector("textarea"); if(ta) ta.value="";
                }
                state.notes.delete(it.id);
              });
              bumpIdle(); alert("Room cleared");
            }).catch(function(){ alert("Clear failed") });
          };

          var anchor = document.querySelector("#room .drawers"); if(anchor && anchor.parentElement){ anchor.parentElement.insertBefore(wrap, anchor) } else { var list=$("#checklist"); if(list){ list.insertBefore(wrap, list.firstChild) } }
        }).catch(function(){ alert("Could not load admin config") });
      })
    })
  }

  function wireBackButtons(){ $all(".btn.back").forEach(function(b){ b.addEventListener("click", function(){ var t=b.getAttribute("data-nav")||"dashboard"; if(t==="dashboard"){ push("/"); loadRooms() } nav(t) }) }) }
  function setupSearch(){ var i=$("#search"); if(!i) return;
    i.addEventListener("input", function(){ var q=(i.value||"").toLowerCase(); mountRooms((state.rooms||[]).filter(r=>!r.hidden && ((r.id||"").toLowerCase().indexOf(q)>=0 || (r.name||"").toLowerCase().indexOf(q)>=0))) });
    i.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); i.blur() } });
    i.addEventListener("search", function(){ i.blur() });
  }

  document.addEventListener("DOMContentLoaded", function(){
    setupSearch(); loadRooms(); metrics(); wireAdminPanel(); wireRoomAdmin(); wireBackButtons(); route();
    setInterval(metrics,15000);
    ["click","touchend","keyup"].forEach(ev=>document.addEventListener(ev, bumpIdle, {passive:true}));
  });
})();
