import 'dotenv/config';
const b=(v,d)=>v==null?d:['1','true','yes','on'].includes(String(v).toLowerCase());
export const config={
 prefix:process.env.PREFIX||'.', phone:(process.env.PHONE_NUMBER||'').replace(/\D/g,''),
 owners:(process.env.OWNER_NUMBERS||'').split(',').map(x=>x.replace(/\D/g,'')).filter(Boolean),
 pairingTimeoutMs:Math.max(10000,Number(process.env.PAIRING_TIMEOUT_MS||180000)),
 lockMs:Math.max(0,Number(process.env.LOCK_MS||15000)), securityMessages:b(process.env.SECURITY_MESSAGES,true),
 sendSecurityImage:b(process.env.SEND_SECURITY_IMAGE,true), logLevel:process.env.LOG_LEVEL||'info',
 authDir:'auth', dataDir:'data', image:'assets/volcano.png'
};
