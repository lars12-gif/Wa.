import fs from 'node:fs/promises'; import path from 'node:path'; import {config} from './config.js';
const file=path.join(config.dataDir,'groups.json'); let db={groups:{}}; let chain=Promise.resolve();
export async function initStore(){await fs.mkdir(config.dataDir,{recursive:true}); try{db=JSON.parse(await fs.readFile(file,'utf8'));}catch{await save();}}
async function save(){const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(db,null,2));await fs.rename(tmp,file)}
const persist=()=>{chain=chain.then(save,save);return chain};
export const installed=jid=>!!db.groups?.[jid]?.enabled;
export async function install(jid,by){db.groups[jid]={enabled:true,by,at:new Date().toISOString()};await persist();return db.groups[jid]}
export async function uninstall(jid){delete db.groups[jid];await persist()}
export const info=jid=>db.groups?.[jid]||null;
export const all=()=>Object.entries(db.groups||{}).filter(([,v])=>v.enabled).map(([jid,v])=>({jid,...v}));
