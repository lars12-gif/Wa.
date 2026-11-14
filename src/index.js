import 'dotenv/config'; import {initStore} from './store.js'; import {startSocket} from './connection.js'; import {commands} from './commands.js'; import {protect,isGroup} from './security.js';
await initStore();
let wired=null;
async function wire(sock){if(wired===sock)return;wired=sock;sock.ev.on('messages.upsert',async({messages,type})=>{if(type!=='notify')return;for(const m of messages){try{if(!m?.message||m.key?.fromMe||!isGroup(m))continue;if(await commands(sock,m))continue;await protect(sock,m);}catch(e){console.error('[MESSAGE]',e?.stack||e)}}});}
process.on('uncaughtException',e=>console.error('[UNCAUGHT]',e));process.on('unhandledRejection',e=>console.error('[UNHANDLED]',e));
await startSocket(wire);
