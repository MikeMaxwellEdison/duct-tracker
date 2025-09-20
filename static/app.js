(function(){
  function $(q,el){ return (el||document).querySelector(q) }
  function $all(q,el){ return Array.prototype.slice.call((el||document).querySelectorAll(q)) }
  function uuid(){ try{ return crypto.randomUUID() }catch(e){ return "u"+Date.now().toString(36)+Math.random().toString(36).slice(2) } }

  // SW (best-effort)
  if("serviceWorker" in navigator){ navigator.serviceWorker.register("/static/sw.js",{scope:"/"}).catch(function(){}) }

  var GLOBAL_ORDER=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed","Ceiling Grid Installed","Ceiling Tile Ready","Ceiling Lined","Rondo Frame Ready","LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested","IBD FD Installed","IBD FD Tested","Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested","VAV Installed","VAV Wired","VCD Actuator Installed","VCD Actuator Wired","VCD Installed"];
  var GROUPS={"Ceiling Grid":["Ceiling Grid Installed","Ceiling Tile Ready"],"Lined Ceiling":["Ceiling Lined","Rondo Frame Ready"],"LR Fire Damper":["LR FD Actuator Installed","LR FD Actuator Wired","LR FD Installed","LR FD Tested"],"IBD Fire Damper":["IBD FD Installed","IBD FD Tested"],"VAV":["VAV Installed","VAV Wired"],"VCD":["VCD Actuator Installed","VCD Actuator Wired","VCD Installed"]};
  var FD_DEP=["Access Panel Installed","SD Actuator Installed","SD Actuator Wired","SD Installed","SD Tested"];
  var NON_REMOVABLE=["Clash / Issue","Duct Installed","Fire Rated","Grille Boxes Installed","Labelled","Penetrations Ready","Subframe & Grilles Installed"];

  var state={ rooms:[], items:new Map(), pinOkUntil:0, currentRoomId:"" };

  function fmtPct(a,b){ if(!b||b<=0) return "0%"; return Math.round(100*a/b)+"%" }

  function httpGet(url){
    if(window.fetch){ return fetch(url).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json() }) }
    return new Promise(function(res,rej){
      var x=new XMLHttpRequest(); x.open("GET",url,true);
      x.onreadystatechange=function(){ if(x.readyState===4){ if(x.status>=200 && x.status<300){ try{res(JSON.parse(x.responseText))}catch(e){rej(e)} } else { rej(new Error("HTTP "+x.status)) } } }
      x.send();
    })
  }
  function httpPostJSON(url,body){
    if(window.fetch){ return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json() }) }
    return new Promise(function(res,rej){
      var x=new XMLHttpRequest(); x.open("POST",url,true); x.setRequestHeader("Content-Type","application/json");
      x.onreadystatechange=function(){ if(x.readyState===4){ if(x.status>=200 && x.status<300){ try{res(JSON.parse(x.responseText))}catch(e){rej(e)} } else { rej(new Error("HTTP "+x.status)) } } }
      x.send(JSON.stringify(body||{}));
    })
  }

  function metrics(){
    httpGet("/api/metrics").then(function(m){
      var floors = m && m.floors ? m.floors : {};
      var g = floors["N-0"] || {rooms:0,complete:0};
      var l1 = floors["N-1"] || {rooms:0,complete:0};
      $("#ring-ground-val").textContent = fmtPct(g.complete,g.rooms);
      $("#ring-level1-val").textContent = fmtPct(l1.complete,l1.rooms);
    }).catch(function(){
      $("#ring-ground-val").textContent="0%";
      $("#ring-level1-val").textContent="0%";
    })
  }
  setInterval(metrics, 15000);

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
    wrap.onclick=function(e){
      var t=e.target;
      if(t && t.tagName==="BUTTON" && t.getAttribute("data-room")){ openRoom(t.getAttribute("data-room")) }
    }
  }

  function loadRooms(){
    httpGet("/api/rooms").then(function(rs){
      state.rooms = rs||[];
      mountRooms(state.rooms);
    }).catch(function(){
      mountRooms([]);
    })
  }

  function nav(id){
    $all(".screen").forEach(function(s){ s.classList.remove("active") });
    var el=document.getElementById(id); if(el) el.classList.add("active");
  }

  function setupSearch(){
    var i=document.getElementById("search");
    if(!i) return;
    i.addEventListener("input", function(){
      var q=(i.value||"").toLowerCase();
      var filtered=(state.rooms||[]).filter(function(r){
        return !r.hidden && ((r.id||"").toLowerCase().indexOf(q)>=0 || (r.name||"").toLowerCase().indexOf(q)>=0)
      });
      mountRooms(filtered);
    });
  }

  function openRoom(roomId){
    state.currentRoomId=roomId;
    var title=document.getElementById("roomTitle"); if(title) title.textContent=roomId;
    nav("room");
    httpGet("/api/rooms/"+encodeURIComponent(roomId)+"/items").then(function(items){
      items = items || [];
      items.sort(function(a,b){ return GLOBAL_ORDER.indexOf(a.name) - GLOBAL_ORDER.indexOf(b.name) });
      state.items.set(roomId, items);
      renderChecklist(roomId);
      if(window.setupViewers) try{ window.setupViewers(roomId) }catch(e){}
    }).catch(function(){
      state.items.set(roomId, []);
      renderChecklist(roomId);
    });
  }

  function segHTML(){ return '<div class="seg"><button class="pass">PASS</button><button class="fail">FAIL</button><button class="na">NA</button></div>' }

  function renderChecklist(roomId){
    var items = state.items.get(roomId) || [];
    var wrap = document.getElementById("checklist"); if(!wrap) return; wrap.innerHTML="";
    for(var i=0;i<items.length;i++){
      var it=items[i]; if(it.hidden) continue;
      var card=document.createElement("div"); card.className="item"; card.setAttribute("data-item-id", it.id);
      card.innerHTML=
        '<div class="item-h"><div class="item-name">'+it.name+'</div>'+segHTML()+'</div>'+
        '<div class="note"><textarea placeholder="Note...">'+(it.note||"")+'</textarea></div>'+
        '<div class="controls">'+
          '<label class="control"><input type="file" accept="image/*" capture="environment" hidden> 📷 Camera</label>'+
          '<label class="control"><input type="file" accept="image/*" multiple hidden> 🖼️ Gallery</label>'+
        '</div>'+
        '<div class="photo-row"></div>';
      var seg=card.querySelector(".seg");
      seg.addEventListener("click", function(e){
        var t=e.target; if(!t || t.tagName!=="BUTTON") return;
        var note=card.querySelector("textarea").value;
        sendStatus(it.id, t.textContent, note);
        $all("button", seg).forEach(function(b){ b.style.outline="" });
        t.style.outline="2px solid #8fb3ff";
      });
      var ctrls=card.querySelectorAll("label.control");
      ctrls[0].addEventListener("click", function(){ photo(card,it,true) });
      ctrls[1].addEventListener("click", function(){ photo(card,it,false) });
      wrap.appendChild(card);
    }
  }

  function sendStatus(itemId,status,note){
    var fd=new FormData();
    fd.append("status", status||""); if(note) fd.append("note", note);
    fd.append("updatedAt", new Date().toISOString()); fd.append("clientId", uuid());
    fetch("/api/items/"+encodeURIComponent(itemId)+"/status",{method:"POST", body:fd}).catch(function(){});
  }

  function photo(card,it,camera){
    var inp=document.createElement("input"); inp.type="file"; inp.accept="image/*"; if(camera) inp.setAttribute("capture","environment"); inp.multiple=true;
    inp.onchange=function(){
      var fs=Array.prototype.slice.call(inp.files||[]); if(!fs.length) return;
      var thumbs=card.querySelector(".photo-row");
      var con = navigator.connection || {};
      var wifi = con.effectiveType ? !/2g|slow-2g/.test(con.effectiveType) : true;
      var saveData = con.saveData===true;
      fs.forEach(function(f){
        low(f).then(function(blob){
          var url=URL.createObjectURL(blob);
          var d=document.createElement("div"); d.className="thumb"; d.innerHTML='<img src="'+url+'" style="width:100%;height:100%;object-fit:cover">';
          thumbs.insertBefore(d, thumbs.firstChild);
          var pid=uuid();
          var fd=new FormData(); fd.append("itemId",it.id); fd.append("photoId",pid); fd.append("createdAt", new Date().toISOString()); fd.append("file",blob,"low.jpg");
          fetch("/api/photos/lowres",{method:"POST",body:fd}).catch(function(){});
          if(wifi && !saveData){
            var fd2=new FormData(); fd2.append("itemId",it.id); fd2.append("photoId",pid); fd2.append("file",f,"hi.jpg");
            fetch("/api/photos/hires",{method:"POST",body:fd2}).catch(function(){});
          }
        });
      });
    };
    inp.click();
  }

  function low(file){
    return new Promise(function(resolve){
      var img=new Image(); img.onload=function(){
        var max=640; var r=Math.min(max/img.naturalWidth, max/img.naturalHeight, 1);
        var w=Math.round(img.naturalWidth*r), h=Math.round(img.naturalHeight*r);
        var c=document.createElement("canvas"); c.width=w; c.height=h;
        var x=c.getContext("2d"); x.drawImage(img,0,0,w,h);
        c.toBlob(function(b){ resolve(b) }, "image/jpeg", 0.75);
      }; img.src=URL.createObjectURL(file);
    });
  }

  function pinOk(){ return Date.now() < state.pinOkUntil }
  function ensurePIN(){
    return new Promise(function(resolve){
      if(pinOk()) return resolve(true);
      var p=prompt("Enter Admin PIN"); if(!p) return resolve(false);
      httpPostJSON("/api/admin/login",{pin:p}).then(function(){
        state.pinOkUntil=Date.now()+30*60*1000; resolve(true)
      }).catch(function(){ alert("Incorrect PIN"); resolve(false) })
    })
  }

  function wireAdminPanel(){
    var btn=document.getElementById("adminBtn");
    if(btn){ btn.addEventListener("click", function(){ ensurePIN().then(function(ok){ if(!ok) return;
      var list=document.getElementById("hiddenRooms"); if(list) list.innerHTML="";
      (state.rooms||[]).forEach(function(r){
        var row=document.createElement("label"); row.className="switch";
        row.innerHTML='<input type="checkbox" '+(r.hidden? "" : "checked")+' data-room="'+r.id+'"> '+r.id;
        list.appendChild(row);
      });
      var save=document.getElementById("adminSaveHidden");
      if(save){ save.onclick=function(){
        var boxes=$all('input[type=checkbox]', list);
        var updates = boxes.map(function(b){
          return { id:b.getAttribute("data-room"), hidden: (b.checked?0:1)===1 };
        });
        httpPostJSON("/api/admin/rooms/hidden-batch", { rooms: updates }).then(function(){
          boxes.forEach(function(b){
            var rm=(state.rooms||[]).find(function(x){ return x.id===b.getAttribute("data-room") });
            if(rm) rm.hidden = b.checked?0:1;
          });
          mountRooms(state.rooms); metrics(); alert("Saved");
        }).catch(function(){ alert("Save failed") });
      } }
      nav("adminPanel");
    }) }) }
  }

  function wireRoomAdmin(){
    var pinBtn=document.getElementById("pinBtn");
    if(!pinBtn) return;
    pinBtn.addEventListener("click", function(){
      ensurePIN().then(function(ok){ if(!ok) return;
        var rid=state.currentRoomId;
        httpGet("/api/admin/room-config/"+encodeURIComponent(rid)).then(function(cfg){
          cfg = cfg || {includeGroups:[], hideRoom:false};
          var wrap=document.createElement("div"); wrap.className="item"; wrap.innerHTML='<div class="item-name">Configure Checklist Groups</div>';
          Object.keys(GROUPS).forEach(function(g){
            var lab=document.createElement("label"); lab.className="switch";
            var checked = (cfg.includeGroups||[]).indexOf(g)>=0 ? "checked" : "";
            lab.innerHTML='<input type="checkbox" data-g="'+g+'" '+checked+'> '+g;
            wrap.appendChild(lab);
          });
          var dep=document.createElement("div"); dep.className="note"; dep.textContent="If LR Fire Damper or IBD Fire Damper is enabled, these are auto-included: "+FD_DEP.join(", ");
          wrap.appendChild(dep);
          var hide=document.createElement("label"); hide.className="switch"; hide.innerHTML='<input type="checkbox" id="hideRoom" '+(cfg.hideRoom?'checked':'')+'> Hide this room';
          wrap.appendChild(hide);
          var save=document.createElement("button"); save.className="btn primary"; save.textContent="Save";
          save.onclick=function(){
            var enabled=$all('input[data-g]:checked', wrap).map(function(i){ return i.getAttribute("data-g") });
            var hideRoom = !!($('#hideRoom', wrap).checked);
            httpPostJSON("/api/admin/room-config/"+encodeURIComponent(rid), { includeGroups: enabled, hideRoom: hideRoom }).then(function(){
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
          var list=document.getElementById("checklist"); if(list){ list.insertBefore(wrap, list.firstChild) }
        }).catch(function(){ alert("Could not load admin config") });
      })
    })
  }

  function wireBackButtons(){
    $all(".btn.back").forEach(function(b){
      b.addEventListener("click", function(){ var target=b.getAttribute("data-nav")||"dashboard"; nav(target) })
    })
  }

  document.addEventListener("DOMContentLoaded", function(){
    setupSearch();
    loadRooms();
    metrics();
    wireAdminPanel();
    wireRoomAdmin();
    wireBackButtons();
    // default screen state: dashboard already active
  });
})();
