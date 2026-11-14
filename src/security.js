import fs from 'node:fs/promises'; import {config} from './config.js'; import {installed} from './store.js';
const seen=new Map(); const locks=new Map();
const now=()=>Date.now();
function sender(m){return m?.key?.participant||m?.participant||null}
function isContact(m){const x=m?.message;return !!(x?.contactMessage||x?.contactsArrayMessage)}
function contactsCount(m){return m?.message?.contactsArrayMessage?.contacts?.length|| (m?.message?.contactMessage?1:0)}
function isGroup(m){return m?.key?.remoteJid?.endsWith('@g.us')}
function dedupe(key){const t=now();const old=seen.get(key);if(old&&t-old<15000)return true;seen.set(key,t); if(seen.size>5000){for(const [k,v] of seen)if(t-v>30000)seen.delete(k)}return false}
async function del(sock,key){try{await sock.sendMessage(key.remoteJid,{delete:key});return true}catch(e){return false}}
async function kick(sock,jid,p){try{await sock.groupParticipantsUpdate(jid,[p],'remove');return true}catch(e){return false}}
async function lock(sock,jid){try{await sock.groupSettingUpdate(jid,'announcement');return true}catch(e){return false}}
async function unlock(sock,jid){try{await sock.groupSettingUpdate(jid,'not_announcement');return true}catch(e){return false}}
export async function protect(sock,m){if(!isGroup(m)||!installed(m.key.remoteJid)||!isContact(m)||m.key.fromMe)return false;const jid=m.key.remoteJid;const key=m.key.id; if(!key||dedupe(jid+':'+key))return true;
 const p=sender(m); let meta=null; try{meta=await sock.groupMetadata(jid)}catch{}
 const admins=new Set((meta?.participants||[]).filter(x=>x.admin).map(x=>x.id));
 const me=sock.user?.id; const botAdmin=admins.has(me)||admins.has(me?.split(':')[0]+'@s.whatsapp.net');
 // Requested critical order: KICK -> DELETE -> LOCK. Each action is attempted in that order.
 const result={kicked:false,deleted:false,locked:false};
 if(p&&!admins.has(p)&&botAdmin)result.kicked=await kick(sock,jid,p);
 result.deleted=await del(sock,m.key);
 result.locked=await lock(sock,jid);
 if(config.securityMessages)await notice(sock,jid,result,contactsCount(m));
 const previous=locks.get(jid); if(previous)clearTimeout(previous); locks.set(jid,setTimeout(()=>{unlock(sock,jid).catch(()=>{});locks.delete(jid)},config.lockMs));
 return true;
}
async function notice(sock,jid,r,count){const text=['🔥 فولكانو — تم صد هجوم','',`📇 البطاقات: ${count}`,'🚫 طرد المرسل: '+(r.kicked?'تم':'تعذر'),'🗑️ حذف الرسالة: '+(r.deleted?'تم':'تعذر'),'🔒 قفل الطوارئ: '+(r.locked?'تم':'تعذر'),`⏱️ وضع الحماية: ${Math.round(config.lockMs/1000)} ثانية`,'','🌋 VOLCANO SECURITY'].join('\n');try{if(config.sendSecurityImage){const image=await fs.readFile(config.image);await sock.sendMessage(jid,{image,caption:text});}else await sock.sendMessage(jid,{text});}catch{}}
export {isGroup,isContact};
