const API = "http://127.0.0.1:8173";
const urlEl = document.getElementById("url");
const message = document.getElementById("message");
let currentUrl = "";

async function getCurrentTab(){ const tabs = await browser.tabs.query({active:true,currentWindow:true}); return tabs[0]; }
function validTikTok(url){ try{ const parsed=new URL(url); return parsed.hostname==="tiktok.com" || parsed.hostname.endsWith(".tiktok.com"); }catch{return false;} }
function say(text,type=""){ message.textContent=text; message.className=type; }
async function ping(){ const res=await fetch(`${API}/api/health`); if(!res.ok) throw new Error("TikSave Local no está disponible."); }

async function init(){
  try{
    const tab=await getCurrentTab();
    currentUrl=tab?.url || "";
    urlEl.textContent=currentUrl || "No se pudo leer la pestaña actual.";
    if(!validTikTok(currentUrl)){
      document.querySelectorAll("[data-mode]").forEach(b=>b.disabled=true);
      say("Abre un TikTok público y vuelve a pulsar la extensión.","error");
      return;
    }
    await ping();
    say("TikSave Local está listo.","ok");
  }catch{ say("Abre TikSave Local primero.","error"); }
}

document.querySelectorAll("[data-mode]").forEach(button=>{
  button.addEventListener("click",async()=>{
    try{
      await ping();
      const res=await fetch(`${API}/api/download`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:currentUrl,mode:button.dataset.mode})});
      const data=await res.json();
      if(!res.ok) throw new Error(data.detail || "No se pudo iniciar la descarga.");
      say("Descarga enviada a TikSave.","ok");
    }catch(err){ say(err.message || "No se pudo conectar.","error"); }
  });
});

document.getElementById("open").addEventListener("click",()=>browser.tabs.create({url:API}));
init();
