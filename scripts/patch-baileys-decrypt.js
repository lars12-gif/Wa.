"use strict";

// Backport Baileys PR #2763 to the stable CommonJS 6.7.24 package without
// relying on a GitHub dependency (which some hosting builders cannot prepare).
// The retry uses WhatsApp's own sender_pn/sender_lid or participant_pn/
// participant_lid pairing when the primary JID form fails to decrypt.

const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(process.cwd(), "node_modules", "@whiskeysockets", "baileys");
const candidates = [
    path.join(packageRoot, "lib", "Utils", "decode-wa-message.js"),
    path.join(packageRoot, "lib", "Utils", "decode-wa-message.cjs"),
    path.join(packageRoot, "Utils", "decode-wa-message.js"),
    path.join(packageRoot, "src", "Utils", "decode-wa-message.ts")
];
const target = candidates.find(file => fs.existsSync(file));
if (!target) {
    console.error("[BAILEYS-PATCH] Could not find decode-wa-message.js in the installed @whiskeysockets/baileys package.");
    console.error("[BAILEYS-PATCH] Confirm @whiskeysockets/baileys@6.7.24 is installed and do not use npm install --ignore-scripts.");
    process.exit(1);
}

let source = fs.readFileSync(target, "utf8");
const marker = "ARTHUR_PN_LID_DECRYPT_RETRY_V1";
if (source.includes(marker)) {
    console.log("[BAILEYS-PATCH] PN/LID alternate-address decrypt retry is already installed.");
    process.exit(0);
}

// Compiled CommonJS and TypeScript source versions of the same decrypt call.
const compiledPattern = /msgBuffer\s*=\s*await\s+repository\.decryptMessage\(\s*\{\s*jid:\s*user\s*,\s*type:\s*e2eType\s*,\s*ciphertext:\s*content\s*\}\s*\)\s*;?/m;
const sourcePattern = /msgBuffer\s*=\s*await\s+repository\.decryptMessage\(\s*\{\s*jid:\s*user\s*,\s*type:\s*e2eType\s*,\s*ciphertext:\s*content\s*\}\s*\)\s*;?/m;
const pattern = target.endsWith(".ts") ? sourcePattern : compiledPattern;
const match = source.match(pattern);
if (!match) {
    console.error(`[BAILEYS-PATCH] Found ${path.relative(process.cwd(), target)}, but its decrypt call did not match the expected 6.7.x layout. No file was changed.`);
    console.error("[BAILEYS-PATCH] Installation stopped rather than silently running without the fix. Send this message and the installed Baileys version for a matching patch.");
    process.exit(1);
}

const statement = match[0];
const replacement = `/* ${marker}: backport of WhiskeySockets/Baileys PR #2763 */\n` +
`try {\n` +
`    ${statement}\n` +
`} catch (err) {\n` +
`    const altUser = ${target.endsWith(".ts") ? "isLidUser(user)" : "(0, WABinary_1.isLidUser)(user)"}\n` +
`        ? (stanza.attrs.participant_pn || stanza.attrs.sender_pn)\n` +
`        : (stanza.attrs.participant_lid || stanza.attrs.sender_lid);\n` +
`    if (!altUser || altUser === user) throw err;\n` +
`    try {\n` +
`        msgBuffer = await repository.decryptMessage({\n` +
`            jid: altUser,\n` +
`            type: e2eType,\n` +
`            ciphertext: content\n` +
`        });\n` +
`    } catch {\n` +
`        throw err;\n` +
`    }\n` +
`}`;
source = source.replace(pattern, replacement);
fs.writeFileSync(target, source, "utf8");
console.log(`[BAILEYS-PATCH] Applied PN/LID alternate-address decrypt retry to ${path.relative(process.cwd(), target)}.`);
