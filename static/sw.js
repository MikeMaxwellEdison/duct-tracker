const CACHE='duct-tracker-v1';
const PRECACHE=['/static/index.html','/static/app.css','/static/app.js','/static/manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin===location.origin){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
      if(e.request.method==='GET'&&(u.pathname.startsWith('/static/')||u.pathname==='/')){
        const cl=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,cl))
      }
      return resp
    }).catch(()=>caches.match('/static/index.html'))))
  }else{
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
      if(e.request.method==='GET'){ const cl=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,cl)) }
      return resp
    })))
  }
});