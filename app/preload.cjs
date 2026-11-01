const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('yysls',{
  subscribe:fn=>{const cb=(_,v)=>fn(v);ipcRenderer.on('state',cb);ipcRenderer.send('ready');return()=>ipcRenderer.removeListener('state',cb);},
  subscribeBuff:fn=>{const cb=(_,v)=>fn(v);ipcRenderer.on('buff-state',cb);ipcRenderer.send('buff-ready');return()=>ipcRenderer.removeListener('buff-state',cb);},
  command:action=>{if(['lock','hide','quit','replay','live','toggle-buff-window','toggle-buff-lock'].includes(action))ipcRenderer.send('command',action);}
});
