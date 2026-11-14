import makeWASocket,{Browsers,DisconnectReason,useMultiFileAuthState} from '@whiskeysockets/baileys';
import pino from 'pino'; import fs from 'node:fs/promises'; import path from 'node:path'; import {config} from './config.js';
const log=pino({level:config.logLevel}); let generation=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function startSocket(onReady){
 const myGen=++generation; const {state,saveCreds}=await useMultiFileAuthState(config.authDir);
 const sock=makeWASocket({auth:state,browser:Browsers.ubuntu('Volcano Security'),logger:log,markOnlineOnConnect:false,syncFullHistory:false,generateHighQualityLinkPreview:false});
 sock.ev.on('creds.update',saveCreds);
 let pairingTimer=null;
 if(!state.creds.registered){
   if(!config.phone) throw new Error('PHONE_NUMBER is required for first pairing');
   pairingTimer=setTimeout(async()=>{ if(state.creds.registered)return; log.warn('Pairing window expired after 3 minutes; closing unpaired session'); try{await sock.logout();}catch{} try{await fs.rm(config.authDir,{recursive:true,force:true});await fs.mkdir(config.authDir,{recursive:true});}catch(e){log.error(e,'failed to clean temporary auth');} },config.pairingTimeoutMs);
   try{const code=await sock.requestPairingCode(config.phone); console.log(`\n🌋 VOLCANO PAIRING CODE: ${code}\n⏳ صالح لمدة 3 دقائق فقط.\n`);}catch(e){clearTimeout(pairingTimer);throw e;}
 }
 sock.ev.on('connection.update',async u=>{
   const {connection,lastDisconnect}=u;
   if(connection==='open'){if(pairingTimer){clearTimeout(pairingTimer);pairingTimer=null} log.info('VOLCANO ONLINE'); await onReady(sock);}
   if(connection==='close'){
     if(pairingTimer){clearTimeout(pairingTimer);pairingTimer=null}
     const code=lastDisconnect?.error?.output?.statusCode;
     const loggedOut=code===DisconnectReason.loggedOut;
     const restart=code===DisconnectReason.restartRequired;
     if(myGen!==generation)return;
     if(!loggedOut){log.warn({code,restart},'socket closed; reconnecting'); setTimeout(()=>startSocket(onReady).catch(e=>log.error(e,'reconnect failed')),1500);}
     else log.error('WhatsApp session logged out; manual pairing is required');
   }
 });
 return sock;
}
