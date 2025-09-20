(function(){
  function setupViewers(roomId){
    var v=document.getElementById("viewer"), fr=document.getElementById("fr-viewer");
    [v,fr].forEach(function(el){
      if(!el) return;
      el.innerHTML='<div class="placeholder">No tiles yet</div>';
      el.addEventListener("dblclick",function(){
        var t=document.createElement("div");
        t.className="toast small"; t.textContent="Double Tap received";
        el.appendChild(t); setTimeout(function(){ try{el.removeChild(t)}catch(e){} },1200);
      });
    });
    var level=((roomId||"").indexOf("N-1")>=0)?"AN1.025":"AN1.020";
    fetch("/static/indices/"+level+".json").then(function(r){ return r.ok ? r.json() : null }).then(function(idx){
      if(!idx){ var t=document.getElementById("fr-toast"); if(t) t.hidden=false; return; }
      var rooms = idx.rooms||[];
      var f=null;
      for(var i=0;i<rooms.length;i++){ if(rooms[i].id===roomId){ f=rooms[i]; break } }
      if(!f){ var tt=document.getElementById("fr-toast"); if(tt) tt.hidden=false; return; }
      if(fr) fr.innerHTML = '<div class="placeholder">Auto-zoomed '+level+'</div>';
    }).catch(function(){ var t=document.getElementById("fr-toast"); if(t) t.hidden=false; });
  }
  window.setupViewers = setupViewers;
})();
