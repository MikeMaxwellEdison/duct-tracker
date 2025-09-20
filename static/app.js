(function(){
  function $(q,el){ return (el||document).querySelector(q) }
  function $all(q,el){ return Array.prototype.slice.call((el||document).querySelectorAll(q)) }
  function uuid(){ try{ return crypto.randomUUID() }catch(e){ return "u"+Date.now().toString(36)+Math.random().toString(36).slice(2) } }

  // State
  var GLOBAL_ORDER=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed","Ceiling Grid Installed","Ceiling Tile Ready","Ceiling Lined","Rondo Frame Ready","LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested","IBD FD Installed","IBD FD Tested","Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested","VAV Installed","VAV Wired","VCD Actuator Installed","VCD Actuator Wired","VCD Installed"];
  var GROUPS={"Ceiling Grid":["Ceiling Grid Installed","Ceiling Tile Ready"],"Lined Ceiling":["Ceiling Lined","Rondo Frame Ready"],"LR Fire Damper":["LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested"],"IBD Fire Damper":["IBD FD Installed","IBD FD Tested"],"VAV":["VAV Installed","VAV Wired"],"VCD":["VCD Actuator Installed","VCD Actuator Wired","VCD Installed"]};
  var FD_DEP=["Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested"];
  var NON_REMOVABLE=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed"];
  var state={ rooms:[], items:new Map(), notes:new Map(), pinOkUntil:0, currentRoomId:"", camera:{stream:null,count:0,active:false} };

  // SW (best-effort)
  if("serviceWorker" in navigator){ navigator.serviceWorker.register("/static/sw.js",{scope:"/"}).catch(function(){}) }

  // ----- Rings -----
  function setRing(el, pct){
    pct = Math.max(0, Math.min(100, Math.round(pct||0)));
    if(!el) return;
    el.style.background = "conic-gradient(var(--good) "+pct+"%, #1a2e4f 0)";
    var val = el.querySelector(".ring-val"); if(val) val.textContent = pct+"%";
  }
  function fmtPct(a,b){ if(!b||b<=0) return 0; return Math.round(100*a/b) }
  function metrics(){
    httpGet("/api/metrics").then(function(m){
      var floors = (m&&m.floors)||{};
      var g=floors["N-0"]||{rooms:0,complete:0};
      var l1=floors["N-1"]||{rooms:0,complete:0};
      setRing($("#ring-ground"), fmtPct(g.complete,g.rooms));
      setRing($("#ring-level1"), fmtPct(l1.complete,l1.rooms));
    }).catch(function(){
      setRing($("#ring-ground"), 0); setRing($("#ring-level1"), 0);
    });
  }

  // ----- HTTP helpers -----
  function httpGet(url){ return fetch(url).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json() }) }
  function httpPostJSON(url,body){ return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json() }) }

  // ----- Rooms -----
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
  function loadRooms(){ httpGet("/api/rooms").then(function(rs){ state.rooms=rs||[]; mountRooms(state.rooms) }).catch(function(){ mountRooms([]) }) }

  // ----- Navigation / History -----
  function nav(id){ $all(".screen").forEach(function(s){ s.classList.remove("active") }); var el=document.getElementById(id); if(el) el.classList.add("active") }
  function push(path){ try{ history.pushState({path:path}, "", path) }catch(e){} }
  function route(){
    var p=location.pathname||"/";
    if(p.indexOf("/room/")===0){ var rid=decodeURIComponent(p.slice(6)); openRoom(rid,true); return }
    if(p.indexOf("/admin")===0){ nav("adminPanel"); return }
    nav("dashboard");
  }
  window.addEventListener("popstate", route);

  // ----- Admin session/PIN -----
  function pinOk(){ return Date.now()<state.pinOkUntil }
  function ensurePIN(){ if(pinOk()) return Promise.resolve(true); var p=prompt("Enter Admin PIN"); if(!p) return Promise.resolve(false); return httpPostJSON("/api/admin/login",{pin:p}).then(function(){ state.pinOkUntil=Date.now()+30*60*1000; return true }).catch(function(){ alert("Incorrect PIN"); return false }) }

  // ----- Room page -----
  function segHTML(sel){ return '<div class="seg">'+
    '<button class="pass'+(sel==="PASS"?' selected':'')+'">PASS</button>'+
    '<button class="fail'+(sel==="FAIL"?' selected':'')+'">FAIL</button>'+
    '<button class="na'+(sel==="NA"?' selected':'')+'">NA</button></div>' }
  function renderChecklist(roomId){
    var items=state.items.get(roomId)||[]; var wrap=$("#checklist"); if(!wrap) return; wrap.innerHTML="";
    items.forEach(function(it){
      if(it.hidden) return;
      var savedNote = state.notes.get(it.id);
      var noteVal = (savedNote!=null) ? savedNote : (it.note||"");
      var card=document.createElement("div"); card.className="item"; card.setAttribute("data-item-id", it.id);
      card.innerHTML=
        '<div class="item-h"><div class="item-name">'+it.name+'</div>'+segHTML(it.status||"NA")+'</div>'+
        '<div class="note"><textarea placeholder="Note...">'+noteVal+'</textarea></div>'+
        '<div class="controls">'+
          '<button class="btn" data-cam="'+it.id+'">📷 Camera</button>'+
          '<label class="control"><input type="file" accept="image/*" multiple hidden> 🖼️ Gallery</label>'+
        '</div>'+
        '<div class="photo-row"></div>';
      // Status exclusivity
      var seg=card.querySelector(".seg");
      seg.addEventListener("click", function(e){
        var t=e.target; if(!t || t.tagName!=="BUTTON") return;
        var val = t.classList.contains("pass")?"PASS": t.classList.contains("fail")?"FAIL":"NA";
        $all("button", seg).forEach(function(b){ b.classList.remove("selected") }); t.classList.add("selected");
        var note=card.querySelector("textarea").value; state.notes.set(it.id, note);
        sendStatus(it.id,val,note);
        // Cross-room FD logic stub: if FD Tested -> FAIL, show toast (we can wire reciprocal later)
        if(it.name.indexOf("FD Tested")>=0 && val==="FAIL"){ toast("HOLD: check linked room FD items") }
      });
      // Note persistence
      card.querySelector("textarea").addEventListener("input", function(ev){ state.notes.set(it.id, ev.target.value) });

      // Photo: Camera session (multi-shot)
      card.querySelector('[data-cam]').addEventListener("click", function(){ openCameraSession(it, card) });
      // Photo: Gallery multi-select
      var gal = card.querySelector("label.control input[type=file]");
      gal.addEventListener("change", function(){ var files=Array.prototype.slice.call(gal.files||[]); if(!files.length) return; handleFiles(it, card, files) });

      wrap.appendChild(card);
      // Load existing photos for item
      loadPhotos(it, card);
    });
  }

  function openRoom(roomId, fromRoute){
    state.currentRoomId=roomId; var t=$("#roomTitle"); if(t) t.textContent=roomId;
    if(!fromRoute){ push("/room/"+encodeURIComponent(roomId)) }
    nav("room");
    httpGet("/api/rooms/"+encodeURIComponent(roomId)+"/items").then(function(items){
      items = items || [];
      items.sort(function(a,b){ return GLOBAL_ORDER.indexOf(a.name) - GLOBAL_ORDER.indexOf(b.name) });
      state.items.set(roomId, items);
      renderChecklist(roomId);
      if(window.setupViewers) try{ window.setupViewers(roomId) }catch(e){}
    }).catch(function(){ state.items.set(roomId, []); renderChecklist(roomId) });
  }

  // ----- Photos -----
  function handleFiles(it, card, files){
    var thumbs = card.querySelector(".photo-row");
    var con = navigator.connection||{}; var wifi = con.effectiveType ? !/2g|slow-2g/.test(con.effectiveType) : true; var saveData = con.saveData===true;
    files.forEach(function(f){
      // low-res thumb
      low(f).then(function(blob){
        var pid=uuid();
        // show immediately
        var thumbUrl = URL.createObjectURL(blob);
        addThumb(thumbs, pid, thumbUrl, "/media/low/"+pid+".jpg"); // data href to server copy
        // upload low
        var fd=new FormData(); fd.append("itemId",it.id); fd.append("photoId",pid); fd.append("createdAt", new Date().toISOString()); fd.append("file",blob,"low.jpg");
        fetch("/api/photos/lowres",{method:"POST",body:fd}).catch(function(){});
        // upload hi if good connection
        if(wifi && !saveData){ var fd2=new FormData(); fd2.append("itemId",it.id); fd2.append("photoId",pid); fd2.append("file",f,"hi.jpg"); fetch("/api/photos/hires",{method:"POST",body:fd2}).catch(function(){}); }
      });
    });
  }
  function loadPhotos(it, card){
    httpGet("/api/items/"+encodeURIComponent(it.id)+"/photos").then(function(list){
      var thumbs = card.querySelector(".photo-row"); if(!thumbs) return;
      list.forEach(function(p){
        var href = (p.kind==="HI")? ("/media/hi/"+p.id+".jpg") : ("/media/low/"+p.id+".jpg");
        addThumb(thumbs, p.id, href, href);
      });
    }).catch(function(){});
  }
  function addThumb(container, id, src, href){
    var d=document.createElement("div"); d.className="thumb"; d.innerHTML='<img src="'+src+'" data-href="'+href+'" alt="photo">';
    d.addEventListener("click", function(){ openLightbox(href) });
    container.insertBefore(d, container.firstChild);
  }
  function low(file){ return new Promise(function(resolve){ var img=new Image(); img.onload=function(){ var max=640; var r=Math.min(max/img.naturalWidth, max/img.naturalHeight, 1); var w=Math.round(img.naturalWidth*r), h=Math.round(img.naturalHeight*r); var c=document.createElement("canvas"); c.width=w; c.height=h; var x=c.getContext("2d"); x.drawImage(img,0,0,w,h); c.toBlob(function(b){ resolve(b) },"image/jpeg",0.75) }; img.src=URL.createObjectURL(file) }) }

  // Lightbox
  function openLightbox(href){ var lb=$("#lightbox"); $("#lightboxImg").src=href; lb.hidden=false }
  function closeLightbox(){ $("#lightbox").hidden=true; $("#lightboxImg").src="" }
  $("#lightboxClose").addEventListener("click", closeLightbox)
  $("#lightbox").addEventListener("click", function(e){ if(e.target.id==="lightbox") closeLightbox() })

  // Camera session (multi-shot up to 10)
  function openCameraSession(it, card){
    var modal=$("#camModal"), v=$("#camVideo"), shutter=$("#camShutter"), done=$("#camDone"), count=$("#camCount");
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ // fallback to file picker
      var picker=document.createElement("input"); picker.type="file"; picker.accept="image/*"; picker.multiple=true; picker.setAttribute("capture","environment"); picker.onchange=function(){ var files=Array.prototype.slice.call(picker.files||[]); handleFiles(it, card, files) }; picker.click(); return;
    }
    state.camera.count=0; count.textContent="0/10"; modal.hidden=false; state.camera.active=true;
    navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}}).then(function(stream){
      state.camera.stream=stream; v.srcObject=stream;
    }).catch(function(){ modal.hidden=true; state.camera.active=false; });

    function take(){
      if(!state.camera.active) return;
      if(state.camera.count>=10) return;
      var track = (state.camera.stream && state.camera.stream.getVideoTracks()[0])||null;
      var imgCap = (window.ImageCapture && track)? new ImageCapture(track) : null;
      var c=document.createElement("canvas"); var w=v.videoWidth||800, h=v.videoHeight||600; c.width=w; c.height=h; var x=c.getContext("2d"); x.drawImage(v,0,0,w,h);
      c.toBlob(function(blob){
        state.camera.count++; count.textContent=state.camera.count+"/10";
        handleFiles(it, card, [new File([blob],"cam.jpg",{type:"image/jpeg"})]);
      },"image/jpeg",0.8);
    }
    shutter.onclick=take;
    done.onclick=function(){ try{ state.camera.stream.getTracks().forEach(function(t){t.stop()}) }catch(e){} modal.hidden=true; state.camera.active=false; }
  }

  // ----- Status / notes -----
  function sendStatus(itemId,status,note){
    var fd=new FormData(); fd.append("status",status||""); if(note) fd.append("note",note); fd.append("updatedAt", new Date().toISOString()); fd.append("clientId", uuid());
    fetch("/api/items/"+encodeURIComponent(itemId)+"/status",{method:"POST",body:fd}).catch(function(){});
  }

  // ----- Admin -----
  function wireAdminPanel(){
    var btn=$("#adminBtn"); if(!btn) return;
    btn.addEventListener("click", function(){ ensurePIN().then(function(ok){ if(!ok) return;
      var list=$("#hiddenRooms"); if(list) list.innerHTML="";
      (state.rooms||[]).forEach(function(r){ var row=document.createElement("label"); row.className="switch"; row.innerHTML='<input type="checkbox" '+(r.hidden? "" : "checked")+' data-room="'+r.id+'"> '+r.id; list.appendChild(row) });
      $("#adminSaveHidden").onclick=function(){
        var boxes=$all("#hiddenRooms input[type=checkbox]");
        var updates = boxes.map(function(b){ return { id:b.getAttribute("data-room"), hidden: !b.checked } }); // hidden = !checked
        httpPostJSON("/api/admin/rooms/hidden-batch", { rooms: updates }).then(function(){
          boxes.forEach(function(b){ var rm=(state.rooms||[]).find(function(x){return x.id===b.getAttribute("data-room")}); if(rm) rm.hidden = !b.checked; });
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
        // prevent duplicates
        var existing=$("#admin-config"); if(existing){ try{ existing.remove() }catch(e){} }
        httpGet("/api/admin/room-config/"+encodeURIComponent(rid)).then(function(cfg){
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
          var save=document.createElement("button"); save.className="btn primary"; save.textContent="Save";
          save.onclick=function(){
            var enabled=$all('input[data-g]:checked', wrap).map(function(i){ return i.getAttribute("data-g") });
            var hideRoom = !!($('#hideRoom', wrap).checked);
            httpPostJSON("/api/admin/room-config/"+encodeURIComponent(rid), { includeGroups: enabled, hideRoom: hideRoom }).then(function(){
              // reflect
              var visible={}; NON_REMOVABLE.forEach(function(n){ visible[n]=true });
              enabled.forEach(function(g){ (GROUPS[g]||[]).forEach(function(n){ visible[n]=true }) });
              if(enabled.indexOf("LR Fire Damper")>=0 || enabled.indexOf("IBD Fire Damper")>=0){ FD_DEP.forEach(function(n){ visible[n]=true }) }
              var items = state.items.get(rid) || [];
              items.forEach(function(it){ it.hidden = visible[it.name] ? 0 : 1 });
              var rm=(state.rooms||[]).find(function(r){ return r.id===rid }); if(rm){ rm.hidden = hideRoom?1:0 }
              renderChecklist(rid); mountRooms(state.rooms); metrics(); alert("Saved"); try{ wrap.remove() }catch(e){}
            }).catch(function(){ alert("Save failed") });
          };
          wrap.appendChild(save);
          var list=$("#checklist"); if(list){ list.insertBefore(wrap, list.firstChild) }
        }).catch(function(){ alert("Could not load admin config") });
      })
    })
  }

  function wireBackButtons(){
    $all(".btn.back").forEach(function(b){
      b.addEventListener("click", function(){ var target=b.getAttribute("data-nav")||"dashboard"; if(target==="dashboard"){ push("/") } nav(target) })
    })
  }

  // Search
  function setupSearch(){
    var i=$("#search"); if(!i) return;
    i.addEventListener("input", function(){
      var q=(i.value||"").toLowerCase();
      var filtered=(state.rooms||[]).filter(function(r){ return !r.hidden && ((r.id||"").toLowerCase().indexOf(q)>=0 || (r.name||"").toLowerCase().indexOf(q)>=0) });
      mountRooms(filtered);
    });
  }

  // Boot
  document.addEventListener("DOMContentLoaded", function(){
    setupSearch(); loadRooms(); metrics(); wireAdminPanel(); wireRoomAdmin(); wireBackButtons(); route();
    setInterval(metrics,15000);
  });
})();
