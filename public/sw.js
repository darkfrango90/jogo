const CACHE="hangman-arena-v3";
const SHELL=["/","/manifest.webmanifest","/icon.svg","/icon-192.png","/icon-512.png","/icon-maskable-512.png"];
self.trimCache=async cache=>{const keys=await cache.keys();await Promise.all(keys.slice(0,Math.max(0,keys.length-40)).map(key=>cache.delete(key)))};
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));self.skipWaiting()});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener("fetch",event=>{const request=event.request,url=new URL(request.url);if(request.method!=="GET"||url.origin!==self.location.origin||url.pathname.startsWith("/api/"))return;event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(async cache=>{await cache.put(request,copy);await self.trimCache(cache)})}return response}).catch(()=>caches.match(request).then(hit=>hit||caches.match("/"))))});
