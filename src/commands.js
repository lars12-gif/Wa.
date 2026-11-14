import {config} from './config.js'; import {install,uninstall,info,all} from './store.js';
const parse=t=>{if(!t.startsWith(config.prefix))return null;const [name,...args]=t.slice(config.prefix.length).trim().split(/\s+/);return {name:(name||'').toLowerCase(),args}};
export async function commands(sock,m){const jid=m.key.remoteJid;if(!jid?.endsWith('@g.us'))return false;const body=m.message?.conversation||m.message?.extendedTextMessage?.text||'';const c=parse(body);if(!c)return false;const meta=await sock.groupMetadata(jid);const actor=m.key.participant;const part=meta.participants?.find(p=>p.id===actor);const admin=!!part?.admin;const owner=config.owners.includes((actor||'').split('@')[0]);if(!admin&&!owner){await sock.sendMessage(jid,{text:'⛔ الأمر للمشرفين فقط.'},{quoted:m});return true}
 if(['تنصيب','install'].includes(c.name)){await install(jid,actor);await sock.sendMessage(jid,{text:'🌋 فولكانو — الحماية مفعّلة\n\n🛡️ Contact Guard: ON\n⚔️ Attack Guard: ON\n🚫 Auto Kick: ON\n🗑️ Auto Delete: ON\n🔒 Emergency Lock: ON\n\n🔥 فولكانو يحرس المجموعة الآن.'});return true}
 if(['الغاء','إلغاء','uninstall'].includes(c.name)){await uninstall(jid);await sock.sendMessage(jid,{text:'🌋 تم إلغاء تنصيب فولكانو لهذه المجموعة.'});return true}
 if(['حالة','status'].includes(c.name)){await sock.sendMessage(jid,{text:info(jid)?'🛡️ فولكانو مفعّل ✅\nContact Guard: ON\nAttack Guard: ON\nEmergency Lock: ON':'🛡️ فولكانو غير مفعّل ❌'});return true}
 if(['مساعدة','help'].includes(c.name)){await sock.sendMessage(jid,{text:'🌋 VOLCANO\n\n.تنصيب — تفعيل الحماية\n.إلغاء — إيقاف الحماية\n.حالة — حالة الحماية\n.مساعدة — الأوامر'});return true}
 if(c.name==='المجموعات'&&owner){const g=all();await sock.sendMessage(jid,{text:`🌋 المجموعات المحمية: ${g.length}\n\n`+g.map((x,i)=>`${i+1}. ${x.jid}`).join('\n')});return true}
 return false;
}
