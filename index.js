const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

require("dotenv").config();

const pino = require("pino");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ============================================================
// Arthur | Arthur
// ============================================================

// ==============================
// 🔧 NUMBER NORMALIZATION
// ==============================

// Must be declared before any startup/session code uses it.
function normalizeNumber(number) {
    return String(number || "")
        .replace(/\D/g, "");
}

// ==============================
// ⚙️ CONFIG
// ==============================

const AUTH_FOLDER = "./auth_info_baileys";
const SESSIONS_FOLDER = "./sessions";
const PENDING_SESSIONS_FOLDER = "./pending_sessions";
const SESSIONS_CONFIG_FILE = "./sessions_config.json";
const INSTALLED_GROUPS_FILE = "./installed_groups.json";
const KEYWORD_REPLIES_FILE = "./keyword_replies.json";
const ARTHUR_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
// Put a different image for each featured command in ./assets/.
// Missing command-specific images fall back to arthur.jpg, then to text-only cards.
const ARTHUR_COMMAND_IMAGES = {
    commands: process.env.ARTHUR_COMMANDS_IMAGE || "./assets/commands.jpg",
    status: process.env.ARTHUR_STATUS_IMAGE || "./assets/status.jpg",
    about: process.env.ARTHUR_ABOUT_IMAGE || "./assets/about.jpg",
    security: process.env.ARTHUR_SECURITY_IMAGE || "./assets/security.jpg",
    religious: process.env.ARTHUR_RELIGIOUS_IMAGE || "./assets/religious.jpg",
    keywords: process.env.ARTHUR_KEYWORDS_IMAGE || "./assets/keywords.jpg",
    sessions: process.env.ARTHUR_SESSIONS_IMAGE || "./assets/sessions.jpg",
    settings: process.env.ARTHUR_SETTINGS_IMAGE || "./assets/settings.jpg",
    default: process.env.ARTHUR_IMAGE_PATH || "./assets/arthur.jpg"
};
const OUTBOUND_MIN_INTERVAL_MS = 1100;
const SOCKET_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// 🌐 HEALTH / WATCHDOG
const HEALTH_PORT = Number(process.env.PORT || process.env.HEALTH_PORT || 3000) || 3000;
const HEALTH_HOST = process.env.HEALTH_HOST || "0.0.0.0";
const HEALTH_SELF_PING_URL =
    process.env.HEALTH_URL ||
    `http://127.0.0.1:${HEALTH_PORT}/health`;
const HEALTH_SELF_PING_MS = 4 * 60 * 1000;
const HEALTH_CHECK_MS = 5 * 60 * 1000;
const HEALTH_PROBE_TIMEOUT_MS = 15000;
const HEALTH_STALE_THRESHOLD = 3;
const WATCHDOG_LOG_FILE = "./watchdog.log";


// ⚡ أول جهة اتصال = بدء المكافحة مباشرة
const REQUIRED_CONTACTS = 1;

// 📡 مدة الاحتفاظ بسجل جهات الاتصال المتتابعة
// لا يوجد انتظار قبل بدء المكافحة؛ هذه المدة فقط لتجميع الرسائل
// التي تصل أثناء تنفيذ عملية الطرد/القفل.
const DETECTION_WINDOW_MS = 3000;

// 🔒 مدة منع تكرار نفس العملية داخل نفس العملية البرمجية
const SECURITY_COOLDOWN_MS = 60000;

// ⏳ مدة انتظار الاقتران
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

// 🔄 إعادة محاولة 515
const PENDING_RESTART_DELAY_MS = 2500;

// ⚡ سرعة الحماية: الحذف يبدأ فور تسجيل أول Contact.
// نافذة المتابعة قصيرة وتلتقط Contacts المتأخرة بدون تأخير بدء الحماية.
const SECURITY_COLLECTION_QUIET_MS = 250;
const SECURITY_COLLECTION_MAX_MS = 3500;
const SECURITY_POLL_MS = 10;
const SECURITY_DELETE_QUEUE_TIMEOUT_MS = 5000;
const SECURITY_DELETE_MAX_ATTEMPTS = 3;

// 🪖 الهوية
const BOT_NAME = "◆ ARTHUR ◆";
const BOT_TITLE = "ARTHUR | OFFICIAL";
const MAIN_OWNER_NUMBER = normalizeNumber(process.env.MAIN_OWNER_NUMBER || "");
if (MAIN_OWNER_NUMBER.length < 8 || MAIN_OWNER_NUMBER.length > 15) {
    console.error("[CONFIG] ضع رقم واتساب بصيغة دولية في متغير MAIN_OWNER_NUMBER (أرقام فقط أو مع +). مثال الصيغة: 9647XXXXXXXXX");
    process.exit(1);
}
const OWNER_DISPLAY_NAME = "Arthur";
const DEVELOPER_FOOTER = "\n\n──────────────\n© ARTHUR\n──────────────";

// ==============================
// 🖥️ CONSOLE MESSAGE READER
// ==============================
// هذه الأدوات للعرض في الكونسول فقط، ولا تدخل في منطق الحماية أو الأوامر.
let consoleMessageSequence = 0;

function nextConsoleMessageId() {
    consoleMessageSequence =
        (consoleMessageSequence + 1) % 100000;

    return String(consoleMessageSequence)
        .padStart(5, "0");
}

function consoleTime() {
    return new Date().toLocaleTimeString("ar-IQ", {
        hour12: false
    });
}

function compactConsoleText(value, limit = 320) {
    const text = String(value ?? "")
        .replace(/\r/g, "")
        .replace(/\n+/g, " ↵ ")
        .replace(/[ \t]+/g, " ")
        .trim();

    if (!text) {
        return "(بدون نص)";
    }

    if (text.length <= limit) {
        return text;
    }

    return `${text.slice(0, limit - 1)}…`;
}

function getReadableMessageType(messageContent, body, command) {
    if (getContactCount(messageContent) > 0) {
        return `CONTACT × ${getContactCount(messageContent)}`;
    }

    if (command) {
        return `COMMAND ${command}`;
    }

    if (body?.trim()) {
        return "TEXT";
    }

    const keys = Object.keys(messageContent || {});

    const knownTypes = [
        ["imageMessage", "IMAGE"],
        ["videoMessage", "VIDEO"],
        ["audioMessage", "AUDIO"],
        ["documentMessage", "DOCUMENT"],
        ["stickerMessage", "STICKER"],
        ["locationMessage", "LOCATION"],
        ["liveLocationMessage", "LIVE LOCATION"],
        ["reactionMessage", "REACTION"],
        ["pollCreationMessage", "POLL"],
        ["pollUpdateMessage", "POLL UPDATE"],
        ["protocolMessage", "PROTOCOL"],
        ["contactsArrayMessage", "CONTACTS"],
        ["contactMessage", "CONTACT"]
    ];

    for (const [key, label] of knownTypes) {
        if (keys.includes(key)) {
            return label;
        }
    }

    const fallback =
        keys.find(key => /Message$/i.test(key));

    return fallback
        ? fallback.replace(/Message$/i, "").toUpperCase()
        : "UNKNOWN";
}

function logIncomingMessage({
    id,
    session,
    msg,
    jid,
    senderNumber,
    body,
    command,
    messageContent
}) {
    const type =
        getReadableMessageType(
            messageContent,
            body,
            command
        );

    const senderName =
        compactConsoleText(msg?.pushName || "غير معروف", 80);

    const sender =
        senderNumber ||
        msg?.key?.participant ||
        "غير معروف";

    console.log(`\n📥 وَارِد | #${id} | ${consoleTime()}`);
    console.log(`   🤖 الوحدة: ${session?.label || "MAIN"}`);
    console.log(`   👤 المرسل: ${senderName} | ${sender}`);
    console.log(`   👥 القروب: ${jid}`);
    console.log(`   🧩 النوع: ${type}`);
    console.log(`   📝 المحتوى: ${compactConsoleText(body || "", 420)}`);
    console.log("────────────────────────────────────────");
}

function logOutgoingMessage({
    jid,
    text,
    mode = "TEXT",
    sessionLabel = null
}) {
    console.log(`\n📤 صَادِر | ${consoleTime()}`);
    console.log(`   🤖 الوحدة: ${sessionLabel || "MAIN"}`);
    console.log(`   👥 إلى: ${jid}`);
    console.log(`   🧩 النوع: ${mode}`);
    console.log(`   💬 الرد: ${compactConsoleText(text, 420)}`);
    console.log("────────────────────────────────────────");
}

function findSessionBySocket(sock) {
    return getAllSessions().find(
        session => session?.sock === sock
    ) || null;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logMessageHandlerError(prefix, error, session = null) {
    const details = String(error?.stack || error?.message || error || 'Unknown error');
    if (/bad mac|mac verification failed|failed to decrypt|no valid sessions/i.test(details)) {
        console.warn(
            `[DECRYPT][${session?.label || 'unknown'}] WhatsApp message could not be authenticated/decrypted; skipped without deleting session credentials.`
        );
        return;
    }
    console.error(prefix, details);
}

// ==============================
// 📁 FOLDERS
// ==============================

for (const folder of [
    SESSIONS_FOLDER,
    PENDING_SESSIONS_FOLDER,
    "./assets"
]) {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, {
            recursive: true
        });
    }
}

// ==============================
// 💾 SESSION CONFIG
// ==============================

let sessionsConfig = {};

function loadSessionsConfig() {
    try {
        if (!fs.existsSync(SESSIONS_CONFIG_FILE)) {
            sessionsConfig = {};
            return;
        }

        sessionsConfig =
            JSON.parse(
                fs.readFileSync(
                    SESSIONS_CONFIG_FILE,
                    "utf8"
                )
            ) || {};
    } catch (error) {
        console.error(
            "[CONFIG] Failed loading sessions config:",
            error.message
        );

        sessionsConfig = {};
    }
}

function saveSessionsConfig() {
    try {
        fs.writeFileSync(
            SESSIONS_CONFIG_FILE,
            JSON.stringify(
                sessionsConfig,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "[CONFIG] Failed saving sessions config:",
            error.message
        );
    }
}

loadSessionsConfig();

// ==============================
// 🪖 INSTALLED GROUPS
// ==============================

let installedGroups = {};

function loadInstalledGroups() {
    try {
        if (!fs.existsSync(INSTALLED_GROUPS_FILE)) {
            installedGroups = {};
            return;
        }

        installedGroups =
            JSON.parse(
                fs.readFileSync(
                    INSTALLED_GROUPS_FILE,
                    "utf8"
                )
            ) || {};
    } catch (error) {
        console.error(
            "[INSTALL] Failed loading installed groups:",
            error.message
        );

        installedGroups = {};
    }
}

function saveInstalledGroups() {
    try {
        fs.writeFileSync(
            INSTALLED_GROUPS_FILE,
            JSON.stringify(
                installedGroups,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "[INSTALL] Failed saving installed groups:",
            error.message
        );
    }
}

function isGroupInstalled(jid) {
    return Boolean(
        jid &&
        installedGroups[jid]
    );
}

function installGroup(jid, number) {
    if (!jid) {
        return false;
    }

    if (isGroupInstalled(jid)) {
        return false;
    }

    installedGroups[jid] = {
        installedAt: Date.now(),
        installedBy: normalizeNumber(number) || null
    };

    saveInstalledGroups();
    return true;
}

function uninstallGroup(jid) {
    if (!jid || !isGroupInstalled(jid)) {
        return false;
    }

    delete installedGroups[jid];
    saveInstalledGroups();
    return true;
}

loadInstalledGroups();

// ==============================
// 🛡️ SESSION STATE
// ==============================

const linkedSessions = new Map();
const pendingSessions = new Map();
const linkedReconnectAttempts = new Map();
// Prevent two sockets from opening the same account/auth directory concurrently.
const startingLinkedAccounts = new Set();

// =====================================================
// 🔒 GLOBAL SECURITY COORDINATOR
// =====================================================

const securityProcessing = new Map();

// ==============================
// 📡 COMMAND COORDINATOR
// ==============================

const commandProcessing = new Map();
let mainCredsSavePromise = Promise.resolve();
let transientStartupCleanupDone = false;

let mainSession = {
    sock: null,
    label: "ARTHUR",
    number: MAIN_OWNER_NUMBER,
    connected: false,
    protectionEnabled: true,
    contactTracker: new Map(),
    starting: false,
    reconnectTimer: null,
    socketGeneration: 0,
    socketStartedAt: 0,
    reconnectAttempts: 0,
    authInvalid: false,
    healthStaleCount: 0,
    healthProbeFailures: 0,
    healthProbeInFlight: false,
    lastHealthProbeAt: 0,
    lastHealthActivityAt: Date.now()
};

// ==============================
// 🧩 CORE HELPERS
// ==============================

function removeFolder(folder) {
    if (!folder) return false;
    try {
        fs.rmSync(folder, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`[FS] Failed removing ${folder}:`, error?.message || error);
        return false;
    }
}

function mergeAuthStateFolder(source, destination) {
    if (!source || !fs.existsSync(source)) return false;
    fs.mkdirSync(destination, { recursive: true });

    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            mergeAuthStateFolder(sourcePath, destinationPath);
            continue;
        }
        if (!entry.isFile()) continue;

        let shouldCopy = !fs.existsSync(destinationPath);
        if (!shouldCopy) {
            try {
                shouldCopy = fs.statSync(sourcePath).mtimeMs >= fs.statSync(destinationPath).mtimeMs;
            } catch {
                shouldCopy = true;
            }
        }
        if (shouldCopy) {
            fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
    return true;
}

function getSessionFolder(number) {
    return path.join(SESSIONS_FOLDER, normalizeNumber(number));
}

function getPendingSessionFolder(number) {
    return path.join(PENDING_SESSIONS_FOLDER, normalizeNumber(number));
}

function getAllSessions() {
    const sessions = [];
    const seen = new Set();

    for (const session of [mainSession, ...linkedSessions.values(), ...pendingSessions.values()]) {
        if (!session || seen.has(session)) continue;
        seen.add(session);
        sessions.push(session);
    }

    return sessions;
}

function getModeratorSession(number) {
    const clean = normalizeNumber(number);
    if (!clean) return null;
    if (clean === normalizeNumber(MAIN_OWNER_NUMBER)) return mainSession;
    return linkedSessions.get(clean) || pendingSessions.get(clean) || null;
}

async function isAuthorizedModerator(session, jid, senderNumber) {
    const cleanSender = normalizeNumber(senderNumber);
    if (cleanSender === normalizeNumber(MAIN_OWNER_NUMBER)) return true;

    if (!session?.sock || !jid?.endsWith?.('@g.us') || !cleanSender) {
        return false;
    }

    try {
        const metadata = await session.sock.groupMetadata(jid);
        const participant = (metadata?.participants || []).find(item => {
            const id = String(item?.id || item?.jid || '');
            return normalizeNumber(id) === cleanSender;
        });

        return Boolean(participant?.admin || participant?.isAdmin || participant?.isSuperAdmin);
    } catch (error) {
        console.error('[AUTH] Failed checking group moderator:', error?.message || error);
        return false;
    }
}

async function sendAdminOnlyMessage(session, jid) {
    return sendCommandText(
        session?.sock,
        jid,
        `${BOT_NAME}\n\n⛔ *هذا الأمر للمشرفين فقط.*\n\n👑 المالك أو مشرفو القروب يگدرون يستخدمونه.`,
        '🔐'
    );
}

function parseCommand(text) {
    const value = String(text || '').trim();
    if (!value.startsWith('$')) {
        return { command: '', argsText: value };
    }

    const parts = value.split(/\s+/);
    let command = parts.shift() || '';
    const aliases = {
        '$آية': '$اية'
    };
    command = aliases[command] || command;

    return {
        command,
        argsText: parts.join(' ').trim()
    };
}

function claimCommand(msg, session = null) {
    const messageId = String(msg?.key?.id || '');
    if (!messageId) return true;

    // Different linked WhatsApp accounts can receive the same group message ID.
    // Deduplicate within each account, not globally across every account.
    const accountId = normalizeNumber(session?.number) || String(session?.label || 'MAIN');
    const id = `${accountId}:${messageId}`;
    const now = Date.now();
    const previous = commandProcessing.get(id);
    if (previous && now - previous < 30000) return false;

    commandProcessing.set(id, now);
    setTimeout(() => {
        if (commandProcessing.get(id) === now) commandProcessing.delete(id);
    }, 30000).unref?.();

    return true;
}

function unwrapMessageContent(messageContent) {
    let content = messageContent || {};
    for (let i = 0; i < 8; i += 1) {
        const next =
            content?.ephemeralMessage?.message ||
            content?.viewOnceMessage?.message ||
            content?.viewOnceMessageV2?.message ||
            content?.viewOnceMessageV2Extension?.message ||
            content?.documentWithCaptionMessage?.message ||
            content?.editedMessage?.message ||
            null;
        if (!next || next === content) break;
        content = next;
    }
    return content;
}

function extractMessageBody(messageContent) {
    const content = unwrapMessageContent(messageContent);
    const candidates = [
        content?.conversation,
        content?.extendedTextMessage?.text,
        content?.imageMessage?.caption,
        content?.videoMessage?.caption,
        content?.documentMessage?.caption,
        content?.buttonsResponseMessage?.selectedDisplayText,
        content?.listResponseMessage?.title,
        content?.listResponseMessage?.singleSelectReply?.selectedRowId,
        content?.templateButtonReplyMessage?.selectedDisplayText,
        content?.templateButtonReplyMessage?.selectedId,
        content?.interactiveResponseMessage?.body?.text,
        content?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
    ];

    return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

function getContactCount(messageContent) {
    const content = unwrapMessageContent(messageContent);
    if (!content || typeof content !== 'object') return 0;

    if (content.contactMessage) return 1;
    if (Array.isArray(content.contactsArrayMessage?.contacts)) {
        return content.contactsArrayMessage.contacts.length;
    }

    return 0;
}

function getSenderJid(msg, session) {
    const participant =
        msg?.key?.participant ||
        msg?.participant ||
        (msg?.key?.fromMe ? session?.sock?.user?.id : null);

    return participant ? String(participant) : '';
}

function getSenderNumber(msg, session) {
    const jid = getSenderJid(msg, session);
    return normalizeNumber(
        jid
            .split('@')[0]
            .split(':')[0]
            .split('-')[0]
    );
}

function sendPublicCommand(jid, text) {
    // Kept for backwards compatibility with older command paths.
    // Newer paths should send through the current session socket directly.
    const session = getAllSessions().find(item => item?.currentJid === jid);
    if (session?.sock) return sendCommandText(session.sock, jid, text, '🌸');
    return Promise.resolve(false);
}

function buildStatusMessage() {
    const sessions = getAllSessions();
    const main = mainSession;
    const linked = [...linkedSessions.values()];
    const pending = [...pendingSessions.values()];

    const lines = [
        `${BOT_NAME}`,
        '',
        '📊 *حالة النظام*',
        '',
        `👑 *الرئيسية:* ${main.connected ? '🟢 متصلة' : '🔴 غير متصلة'}`,
        `🛡️ *الحماية:* ${main.protectionEnabled ? '🟢 مفعلة' : '🔴 متوقفة'}`,
        `📱 *الوحدات المرتبطة:* ${linked.length}`,
        `⏳ *طلبات الاقتران:* ${pending.length}`,
        `💾 *الوحدات الكلية:* ${sessions.length}`,
        '',
        ...linked.map(item =>
            `🐾 ${item.label} | ${item.number} | ${item.connected ? '🟢' : '🔴'} | حماية ${item.protectionEnabled ? '🟢' : '🔴'}`
        )
    ];

    return lines.join('\n');
}

function securityRecordIdentity(record) {
    if (!record) return '';
    const key = record.key || record;
    return [
        key?.remoteJid || record.remoteJid || '',
        key?.id || record.id || '',
        key?.participant || record.participant || '',
        key?.fromMe ? '1' : '0'
    ].join('|');
}

function getSecurityKey(jid, sender) {
    return `${jid}|${sender}`;
}

function getSecuritySessionCandidates(preferredSession) {
    const all = getAllSessions().filter(session =>
        session?.sock && !session.deleting &&
        (session === preferredSession || session.connected)
    );
    const unique = [...new Set(all)];
    unique.sort((a, b) => Number(b === preferredSession) - Number(a === preferredSession));
    return unique;
}

async function runSecurityActionWithFallback(preferredSession, actionName, action) {
    const candidates = getSecuritySessionCandidates(preferredSession);
    let lastError = null;

    for (const candidate of candidates) {
        try {
            const result = await action(candidate.sock);
            if (candidate !== preferredSession) {
                console.log(`[SECURITY] ${actionName} completed through linked fallback unit ${candidate.label || candidate.number}.`);
            }
            return result;
        } catch (error) {
            lastError = error;
            console.warn(`[SECURITY] ${actionName} failed through ${candidate.label || candidate.number}: ${error?.message || error}`);
        }
    }

    if (lastError) throw lastError;
    throw new Error(`No connected session available for ${actionName}`);
}

function appendSecurityRecords(jid, sender, records) {
    const caseKey = getSecurityKey(jid, sender);
    const securityCase = securityProcessing.get(caseKey);
    if (!securityCase) return;

    for (const record of records || []) {
        const identity = securityRecordIdentity(record);
        if (!identity || securityCase.recordIds.has(identity)) continue;
        securityCase.recordIds.add(identity);
        securityCase.records.push(record);
        enqueueSecurityDelete(securityCase, record);
    }

    securityCase.lastRecordAt = Date.now();
}

function registerContactMessage(tracker, sender, key, contactCount) {
    const now = Date.now();
    let state = tracker.get(sender);

    if (!state || now - Number(state.lastAt || 0) > DETECTION_WINDOW_MS) {
        state = {
            firstAt: now,
            lastAt: now,
            totalContacts: 0,
            triggeredAt: 0,
            records: [],
            recordIds: new Set()
        };
        tracker.set(sender, state);
    }

    const safeCount = Math.max(1, Number(contactCount) || 1);
    const record = {
        key: {
            remoteJid: key?.remoteJid,
            fromMe: Boolean(key?.fromMe),
            id: key?.id,
            participant: key?.participant
        },
        count: safeCount,
        at: now
    };

    const identity = securityRecordIdentity(record);
    if (identity && !state.recordIds.has(identity)) {
        state.recordIds.add(identity);
        state.records.push(record);
        state.totalContacts += safeCount;
    }

    state.lastAt = now;

    const onCooldown = state.triggeredAt && now - state.triggeredAt < SECURITY_COOLDOWN_MS;
    const triggered = !onCooldown && state.totalContacts >= REQUIRED_CONTACTS;
    if (triggered) state.triggeredAt = now;

    return {
        triggered,
        records: [record],
        totalContacts: state.totalContacts
    };
}

function enqueueSecurityDelete(securityCase, record) {
    if (!securityCase || !record?.key) return Promise.resolve(false);

    const identity = securityRecordIdentity(record);
    if (!identity) return Promise.resolve(false);

    if (securityCase.queuedDeleteIds.has(identity)) {
        return securityCase.deletePromises.get(identity) || Promise.resolve(true);
    }

    securityCase.queuedDeleteIds.add(identity);

    const run = async () => {
        for (let attempt = 1; attempt <= SECURITY_DELETE_MAX_ATTEMPTS; attempt += 1) {
            try {
                await runSecurityActionWithFallback(
                    securityCase.session,
                    `delete contact message ${record.key.id}`,
                    sock => sock.sendMessage(securityCase.jid, { delete: record.key })
                );
                return true;
            } catch (error) {
                if (attempt >= SECURITY_DELETE_MAX_ATTEMPTS) {
                    console.error(`[SECURITY] Failed deleting contact message ${record.key.id}:`, error?.message || error);
                    return false;
                }
                await delay(40 * attempt);
            }
        }
        return false;
    };

    securityCase.deleteQueue = securityCase.deleteQueue
        .catch(() => undefined)
        .then(run);
    securityCase.deletePromises.set(identity, securityCase.deleteQueue);
    return securityCase.deleteQueue;
}

async function activateProtection(session, jid, sender, records, options = {}) {
    const caseKey = getSecurityKey(jid, sender);
    const existingCase = securityProcessing.get(caseKey);
    const performActions = options.performActions !== false;

    // If the case is still collecting messages, add every new contact message
    // to the same deletion queue. A completed/cooldown case must never block deletion.
    if (existingCase && existingCase.status === 'PROCESSING') {
        appendSecurityRecords(jid, sender, records);
        return;
    }

    const securityCase = {
        session,
        jid,
        sender,
        status: 'PROCESSING',
        startedAt: Date.now(),
        lastRecordAt: Date.now(),
        records: [],
        recordIds: new Set(),
        queuedDeleteIds: new Set(),
        deletePromises: new Map(),
        deleteQueue: Promise.resolve()
    };

    securityProcessing.set(caseKey, securityCase);
    appendSecurityRecords(jid, sender, records);

    console.log(`[SECURITY] CONTACT DETECTED | ${sender} | ${jid} | mode=${performActions ? 'FULL' : 'DELETE_ONLY'}`);

    // Every contact message is deleted, including messages received during the
    // 60-second action cooldown. Kick/lock are only repeated when a new protection
    // trigger is allowed by registerContactMessage().
    const kickPromise = performActions
        ? Promise.resolve().then(() =>
            runSecurityActionWithFallback(
                session,
                'kick sender',
                sock => sock.groupParticipantsUpdate(jid, [sender], 'remove')
            )
        ).catch(error => {
            console.error('[SECURITY] Kick failed on all available units:', error?.message || error);
            return null;
        })
        : Promise.resolve(null);

    const lockPromise = performActions
        ? Promise.resolve().then(() =>
            runSecurityActionWithFallback(
                session,
                'lock group',
                sock => sock.groupSettingUpdate(jid, 'announcement')
            )
        ).catch(error => {
            console.error('[SECURITY] Group lock failed on all available units:', error?.message || error);
            return null;
        })
        : Promise.resolve(null);

    // Do not await kick/lock before deletion starts.
    const deletionStarted = securityCase.deleteQueue;

    const deadline = Date.now() + SECURITY_COLLECTION_MAX_MS;
    while (Date.now() < deadline) {
        const quietFor = Date.now() - securityCase.lastRecordAt;
        if (quietFor >= SECURITY_COLLECTION_QUIET_MS) break;
        await delay(SECURITY_POLL_MS);
    }

    await Promise.race([
        securityCase.deleteQueue,
        delay(SECURITY_DELETE_QUEUE_TIMEOUT_MS)
    ]);

    await Promise.allSettled([kickPromise, lockPromise, deletionStarted]);
    securityCase.status = 'DONE';

    setTimeout(() => {
        if (securityProcessing.get(caseKey) === securityCase) {
            securityProcessing.delete(caseKey);
        }
    }, SECURITY_COOLDOWN_MS).unref?.();
}

// ==============================
// 🌈 MESSAGE STYLE
// ==============================

function decorateMessage(text) {
    const safeText = String(text ?? "").trim();

    if (!safeText) {
        return `💫 ${BOT_TITLE}`;
    }

    if (safeText.includes("© ARTHUR") || safeText.includes(BOT_TITLE)) {
        return safeText;
    }

    return `${safeText}${DEVELOPER_FOOTER}`;
}

function stripCardDecorations(text) {
    let body = String(text ?? "").trim();
    if (body.startsWith(BOT_NAME)) body = body.slice(BOT_NAME.length).trim();
    body = body.replace(/\n*(?:✦ حقوق \*Arthur\* ✦|© ARTHUR(?: \| OFFICIAL)?|ARTHUR · OFFICIAL|© ARTHUR \| OFFICIAL|♛ ARTHUR · OFFICIAL)\s*$/u, "").trim();
    body = body.replace(/\n*(?:━━━━━━━━━━━━━━━━━━|──────────────)\s*$/u, "").trim();
    return body;
}

function buildBrightCard(text, accent = "◆") {
    const body = stripCardDecorations(text);
    return `✦ 𝐀𝐑𝐓𝐇𝐔𝐑 | OFFICIAL ✦\n\n${body}\n\n──────────────\n© ARTHUR`;
}

// Rate-limit normal bot replies per destination. Security actions (kick/delete/lock)
// use their dedicated path and are intentionally not delayed by this queue.
const outboundQueues = new Map();
const outboundLastSentAt = new Map();

function enqueueOutbound(sock, jid, task) {
    const socketId = String(sock?.user?.id || sock?.user?.jid || "socket");
    const key = `${socketId}:${jid}`;
    const previous = outboundQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        const lastSentAt = outboundLastSentAt.get(key) || 0;
        const waitMs = OUTBOUND_MIN_INTERVAL_MS - (Date.now() - lastSentAt);
        if (waitMs > 0) await delay(waitMs);
        const result = await task();
        outboundLastSentAt.set(key, Date.now());
        return result;
    });
    outboundQueues.set(key, next);
    next.finally(() => {
        if (outboundQueues.get(key) === next) outboundQueues.delete(key);
    }).catch(() => undefined);
    return next;
}

async function sendFeaturedCommand(sock, jid, text, accent = "🦊") {
    if (!sock || !jid) return false;

    const imageKey = /حالة النظام|حالة البوت|الفحص|فحص/i.test(String(text)) ? "status"
        : /تعريف Arthur|أنا \*ARTHUR\*/i.test(String(text)) ? "about"
        : /قائمة الأوامر|عرض القائمة|الأوامر المتاحة/i.test(String(text)) ? "commands"
        : /الحماية|Contact/i.test(String(text)) ? "security"
        : /دعاء|آية|اية|حديث|ذكر|النشر الديني/i.test(String(text)) ? "religious"
        : /الكلمات|الكلمة|الردود التلقائية/i.test(String(text)) ? "keywords"
        : /الوحدات المرتبطة|الاقتران|الجلسات/i.test(String(text)) ? "sessions"
        : /الإعدادات|الإعداد|تخصيص/i.test(String(text)) ? "settings"
        : "default";
    let imageBuffer = null;
    let imagePath = ARTHUR_COMMAND_IMAGES[imageKey] || ARTHUR_COMMAND_IMAGES.default;
    try {
        // Prefer this command's image, then use the general Arthur image as fallback.
        const candidates = [imagePath, ARTHUR_COMMAND_IMAGES.default].filter(Boolean);
        for (const candidate of [...new Set(candidates)]) {
            if (!fs.existsSync(candidate)) continue;
            const stat = fs.statSync(candidate);
            if (stat.isFile() && stat.size > 0 && stat.size <= ARTHUR_IMAGE_MAX_BYTES) {
                imageBuffer = fs.readFileSync(candidate);
                imagePath = candidate;
                break;
            }
        }
    } catch (error) {
        console.warn("[IMAGE] Failed reading command image:", error?.message || error);
    }

    if (!imageBuffer) {
        return sendCommandText(sock, jid, text, accent);
    }

    const caption = buildBrightCard(text, accent);
    return enqueueOutbound(sock, jid, async () => {
        try {
            await sock.sendMessage(jid, { image: imageBuffer, caption });
            const responder = findSessionBySocket(sock);
            logOutgoingMessage({
                jid, text: caption, mode: "IMAGE + CAPTION",
                sessionLabel: responder?.label || null
            });
            return true;
        } catch (error) {
            console.error("[SEND] Failed sending ARTHUR image card:", error?.message || error);
            // Fallback is sent directly inside the current queue task to avoid
            // waiting on a second task queued behind itself.
            try {
                const fallbackText = buildBrightCard(text, accent);
                await sock.sendMessage(jid, { text: fallbackText });
                const responder = findSessionBySocket(sock);
                logOutgoingMessage({ jid, text: fallbackText, mode: "TEXT FALLBACK", sessionLabel: responder?.label || null });
                return true;
            } catch (fallbackError) {
                console.error("[SEND] Text fallback also failed:", fallbackError?.message || fallbackError);
                return false;
            }
        }
    });
}

async function sendText(sock, jid, text) {
    if (!sock || !jid) {
        return false;
    }

    return enqueueOutbound(sock, jid, async () => {
        try {
            await sock.sendMessage(jid, { text: decorateMessage(text) });
            const responder = findSessionBySocket(sock);
            logOutgoingMessage({ jid, text, mode: "TEXT", sessionLabel: responder?.label || null });
            return true;
        } catch (error) {
            console.error("[SEND] Failed sending text:", error?.message || error);
            return false;
        }
    });
}

async function sendCommandText(sock, jid, text, accent = "🌈") {
    if (!sock || !jid) {
        return false;
    }

    return sendText(
        sock,
        jid,
        buildBrightCard(text, accent)
    );
}

// ==============================
// 🔤 KEYWORD REPLIES
// ==============================

let keywordReplies = {};

function loadKeywordReplies() {
    try {
        if (!fs.existsSync(KEYWORD_REPLIES_FILE)) {
            keywordReplies = {};
            return;
        }
        const raw = JSON.parse(fs.readFileSync(KEYWORD_REPLIES_FILE, "utf8"));
        keywordReplies = raw && typeof raw === "object" ? raw : {};
    } catch (error) {
        console.error("[KEYWORD] Failed loading keyword replies:", error?.message || error);
        keywordReplies = {};
    }
}

loadKeywordReplies();

function saveKeywordReplies() {
    try {
        fs.writeFileSync(KEYWORD_REPLIES_FILE, JSON.stringify(keywordReplies, null, 2), "utf8");
        return true;
    } catch (error) {
        console.error("[KEYWORD] Failed saving keyword replies:", error?.message || error);
        return false;
    }
}

function normalizeKeyword(value) {
    let text = String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[\u0640]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .toLowerCase()
        .trim();

    const replacements = {
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
        "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"
    };
    for (const [from, to] of Object.entries(replacements)) text = text.replaceAll(from, to);

    return text.replace(/[^\w\u0600-\u06FF]+/gu, " ").replace(/\s+/g, " ").trim();
}

function getGroupKeywordMap(jid, create = false) {
    if (!jid) return null;
    if (!keywordReplies[jid] && create) keywordReplies[jid] = {};
    return keywordReplies[jid] || null;
}

function findKeywordReply(jid, text) {
    const map = getGroupKeywordMap(jid, false);
    const key = normalizeKeyword(text);
    if (!map || !key || !Object.prototype.hasOwnProperty.call(map, key)) return null;
    const entry = map[key];
    if (typeof entry === "string") return { trigger: key, reply: entry };
    if (!entry || typeof entry !== "object") return null;
    const reply = String(entry.reply ?? "");
    return reply ? { trigger: String(entry.trigger ?? key), reply } : null;
}

function listKeywordReplies(jid) {
    const map = getGroupKeywordMap(jid, false) || {};
    return Object.entries(map).map(([key, entry]) => ({
        key,
        trigger: String(entry?.trigger ?? key),
        reply: String(entry?.reply ?? entry ?? "")
    })).filter(item => item.reply);
}

// ==============================
// 📜 COMMANDS
// ==============================

const ADMIN_COMMANDS = new Set([
    "$تشغيل",
    "$ايقاف",
    "$اضافة",
    "$حذف",
    "$تعيين_النشر",
    "$وقت_النشر",
    "$ايقاف_النشر",
    "$كلمة",
    "$كلمه",
    "$الكلمات",
    "$حذف_كلمة",
    "$حذف_كلمه",
    "$مسح_الكلمات"
]);

const COMMANDS_MESSAGE = `
*ARTHUR*
_WhatsApp Management System_


*01  الحماية*
$تنصيب  ·  تنصيب البوت في القروب
$الغاء_تنصيب  ·  إزالة التنصيب
$تشغيل  ·  تشغيل الحماية
$ايقاف  ·  إيقاف الحماية

*02  المحتوى الديني*
$دعاء  ·  دعاء
$اية  ·  آية قرآنية
$حديث  ·  حديث
$ذكر  ·  أذكار
$شعر  ·  شعر عشوائي
$شعر_عراقي  ·  شعر عراقي (نص أصلي)
$شعر_فصيح  ·  شعر فصيح (نص أصلي)
$شعر_نبطي  ·  شعر نبطي (نص أصلي)
$بحث_آية رقم  ·  جلب آية من مصدر إلكتروني
$بحث_حديث كلمات  ·  البحث عن حديث من الدرر السنية
$بحث_شعر كلمات  ·  البحث عن الشعر من الديوان

*03  النشر اليومي*
$تعيين_النشر 21:00  ·  تحديد الموعد
$وقت_النشر  ·  عرض الموعد
$ايقاف_النشر  ·  إيقاف النشر

*04  الردود التلقائية*
$كلمة الكلمة|الرد  ·  إضافة رد
$الكلمات  ·  عرض الكلمات
$حذف_كلمة الكلمة  ·  حذف رد
$مسح_الكلمات  ·  مسح القائمة

*05  إدارة الجلسات*
$اضافة اللقب|الرقم  ·  ربط حساب
$حذف اللقب  ·  حذف حساب مرتبط

*06  عام*
$فحص  ·  حالة البوت
$تعريف  ·  معلومات البوت
$الاوامر  ·  هذه القائمة


_واجهة بسيطة • هوية واضحة • أداء مستقر_
© *ARTHUR*`.trim();

function buildDefinitionMessage() {
    return `*ARTHUR*
_WhatsApp Management System_


بوت لإدارة القروبات مع نظام حماية، وردود تلقائية، ومحتوى ديني مجدول، ودعم الجلسات المرتبطة، وأوامر الشعر والبحث عن المحتوى عبر الإنترنت.

*الأنظمة الأساسية*
• حماية القروبات من بطاقات جهات الاتصال.
• أوامر إدارية وصلاحيات للمشرفين.
• ردود مخصصة حسب كلمات تختارها.
• نشر ديني يومي حسب الموعد المحدد.
• مراقبة لصحة الاتصال ومحاولات الاستعادة.


_ببساطة ووضوح 🤍_
© *ARTHUR*`;
}

// ==============================
// 📲 MAIN PAIRING
// ==============================

async function requestMainPairing(sock) {
    try {
        const phoneNumber = MAIN_OWNER_NUMBER;

        mainSession.number = MAIN_OWNER_NUMBER;

        console.log("");
        console.log("========================================");
        console.log("📲 ربط الوحدة الرئيسية | Arthur");
        console.log("========================================");
        console.log(`👑 المالك: ${OWNER_DISPLAY_NAME}`);
        console.log(`📱 الرقم الرئيسي: ${phoneNumber}`);
        console.log("[PAIRING] Requesting pairing code...");

        // نفس توقيت الكود القديم الذي كان يعمل عندك.
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (mainSession.sock !== sock) {
            console.log("[PAIRING] Socket changed before pairing request; aborting this code request.");
            return;
        }

        if (sock.user?.id) {
            console.log("[PAIRING] WhatsApp session is already registered; skipping pairing code.");
            return;
        }

        const code = await sock.requestPairingCode(phoneNumber);

        const formattedCode =
            String(code)
                .match(/.{1,4}/g)
                ?.join("-") || code;

        console.log("");
        console.log("========================================");
        console.log("Arthur | Arthur");
        console.log(`🎖️ الوحدة: ARTHUR`);
        console.log(`👑 المالك: ${OWNER_DISPLAY_NAME}`);
        console.log(`📱 الرقم: ${phoneNumber}`);
        console.log(`🔐 كود الاقتران: ${formattedCode}`);
        console.log("========================================");
        console.log("");

        console.log("📲 افتح واتساب بهذا الرقم:");
        console.log("الإعدادات ← الأجهزة المرتبطة ← ربط جهاز");
        console.log("ثم اختر الربط باستخدام رقم الهاتف.");
        console.log("");
    } catch (error) {
        console.error(
            "[PAIRING] Failed:",
            error?.message || error
        );
    }
}

// ==============================
// ⏳ PENDING TIMEOUT
// ==============================

function startPendingTimeout(session) {
    if (session.pendingTimer) {
        clearTimeout(session.pendingTimer);
    }

    const remaining = Math.max(
        1000,
        session.pendingExpiresAt - Date.now()
    );

    session.pendingTimer = setTimeout(
        async () => {
            if (
                !session.isPending ||
                session.deleting ||
                pendingSessions.get(session.number) !== session
            ) {
                return;
            }

            console.log(
                `[PAIRING] Pending session expired: ${session.number}`
            );

            session.deleting = true;

            pendingSessions.delete(
                session.number
            );

            try {
                session.sock.end();
            } catch {}

            removeFolder(getSessionFolder(session.number));
        },
        remaining
    );
}

// ==============================
// 🔄 RESTART PENDING SESSION
// ==============================

async function restartPendingSession(oldSession) {
    const number = oldSession.number;

    if (oldSession.deleting) {
        return;
    }

    const current =
        pendingSessions.get(number);

    if (
        current &&
        current !== oldSession
    ) {
        return;
    }

    if (
        Date.now() >=
        oldSession.pendingExpiresAt
    ) {
        console.log(
            `[PAIRING] Pending session expired: ${number}`
        );

        pendingSessions.delete(number);

        removeFolder(getSessionFolder(number));

        return;
    }

    console.log(
        `[PAIRING] Restarting pending session ${number}...`
    );

    if (oldSession.pendingTimer) {
        clearTimeout(oldSession.pendingTimer);
        oldSession.pendingTimer = null;
    }

    try {
        oldSession.sock.end();
    } catch {}

    pendingSessions.delete(number);

    await new Promise(resolve =>
        setTimeout(
            resolve,
            PENDING_RESTART_DELAY_MS
        )
    );

    if (oldSession.deleting) {
        return;
    }

    await startLinkedAccount(
        number,
        oldSession.label,
        oldSession.requesterSock,
        oldSession.requesterJid,
        true,
        true,
        oldSession.pendingExpiresAt
    );
}

// ==============================
// 🔄 LINKED ACCOUNT RECONNECT RETRY
// ==============================

function scheduleLinkedAccountReconnect(number, label, delayMs, reason = 'temporary disconnect', attempt = 0) {
    const cleanNumber = normalizeNumber(number);
    if (!cleanNumber || shutdownInProgress) return null;

    const timer = setTimeout(async () => {
        if (shutdownInProgress) return;
        try {
            await startLinkedAccount(cleanNumber, label);
        } catch (error) {
            const nextAttempt = Number(attempt || 0) + 1;
            const backoff = Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(nextAttempt, 6)));
            const jitter = Math.floor(Math.random() * 1200);
            linkedReconnectAttempts.set(cleanNumber, nextAttempt);
            console.error(`[LINKED] Reconnect start failed for ${cleanNumber}; retrying in ${backoff + jitter}ms (${reason}):`, error?.stack || error?.message || error);
            scheduleLinkedAccountReconnect(cleanNumber, label, backoff + jitter, reason, nextAttempt);
        }
    }, Math.max(0, Number(delayMs) || 0));

    timer.unref?.();
    return timer;
}

// ==============================
// 📲 START LINKED ACCOUNT
// ==============================

async function startLinkedAccount(
    phoneNumber,
    label = null,
    requesterSock = null,
    requesterJid = null,
    isNewPairing = false,
    isPendingRestart = false,
    existingExpiry = null
) {
    const cleanNumber =
        normalizeNumber(phoneNumber);

    if (!cleanNumber) {
        return;
    }

    if (linkedSessions.has(cleanNumber)) {
        const existingSession =
            linkedSessions.get(cleanNumber);

        if (requesterSock && requesterJid) {
            await sendCommandText(
                requesterSock,
                requesterJid,
                `${BOT_NAME}


⚠️ الحساب مرتبط بالفعل.

🏷️ اللقب: ${existingSession.label}
📱 الرقم: ${cleanNumber}
🛡️ الحماية: ${existingSession.protectionEnabled ? "مفعلة" : "متوقفة"}`
            );
        }

        return;
    }

    if (
        pendingSessions.has(cleanNumber) &&
        !isPendingRestart
    ) {
        const pending =
            pendingSessions.get(cleanNumber);

        if (requesterSock && requesterJid) {
            await sendCommandText(
                requesterSock,
                requesterJid,
                `${BOT_NAME}


⏳ طلب اقتران قيد الانتظار.

🏷️ اللقب: ${pending.label}
📱 الرقم: ${cleanNumber}

🔐 تم إصدار كود الاقتران مسبقًا.
🎖️ انتظر اكتمال الربط.`
            );
        }

        return;
    }

    if (
        mainSession.number &&
        normalizeNumber(mainSession.number) === cleanNumber
    ) {
        return;
    }

    if (startingLinkedAccounts.has(cleanNumber)) {
        console.warn(`[SESSION] Start already in progress for ${cleanNumber}; duplicate start skipped.`);
        return;
    }
    startingLinkedAccounts.add(cleanNumber);

    try {
    // Use the permanent path from the start of pairing. Baileys' saveCreds/key-store
    // callbacks retain this path; moving the folder while the socket is live can
    // split auth keys across directories and cause decrypt errors such as Bad MAC.
    const sessionFolder = getSessionFolder(cleanNumber);

    if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, {
            recursive: true
        });
    }

    console.log(
        `[SESSION] Starting ${cleanNumber}`
    );

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        sessionFolder
    );

    const savedConfig =
        sessionsConfig[cleanNumber] || {
            label: label || cleanNumber,
            protectionEnabled: true
        };

    const sock = makeWASocket({
        auth: state,
        keepAliveIntervalMs: 30000,
        logger: pino({
            level: "silent"
        }),
        printQRInTerminal: false
    });

    const session = {
        sock,
        label:
            label ||
            savedConfig.label ||
            cleanNumber,
        number: cleanNumber,
        connected: false,
        protectionEnabled:
            savedConfig.protectionEnabled !== false,
        contactTracker: new Map(),
        isPending: isNewPairing,
        requesterSock,
        requesterJid,
        deleting: false,
        pendingExpiresAt:
            existingExpiry ||
            (Date.now() + PENDING_TIMEOUT_MS),
        pendingTimer: null,
        reconnectScheduled: false,
        authInvalid: false,
        healthStaleCount: 0,
        healthProbeFailures: 0,
        healthProbeInFlight: false,
        lastHealthProbeAt: 0,
        socketStartedAt: Date.now(),
        lastHealthActivityAt: Date.now()
    };

    if (isNewPairing) {
        pendingSessions.set(
            cleanNumber,
            session
        );

        startPendingTimeout(session);
    } else {
        linkedSessions.set(
            cleanNumber,
            session
        );
    }

    let linkedCredsSavePromise = Promise.resolve();

    sock.ev.on(
        "creds.update",
        () => {
            linkedCredsSavePromise = linkedCredsSavePromise
                .catch(() => undefined)
                .then(() => saveCreds());
        }
    );

    // ==========================
    // 🔌 CONNECTION
    // ==========================

    sock.ev.on(
        "connection.update",
        async update => {
            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            // ======================
            // 🟢 OPEN
            // ======================

            if (connection === "open") {
                session.connected = true;
                linkedReconnectAttempts.delete(cleanNumber);
                session.reconnectScheduled = false;
                session.authInvalid = false;
                session.healthStaleCount = 0;
                session.healthProbeFailures = 0;
                session.healthProbeInFlight = false;
                session.lastHealthProbeAt = 0;

                console.log(
                    `[LINKED] ${cleanNumber} connected successfully.`
                );

                if (session.pendingTimer) {
                    clearTimeout(
                        session.pendingTimer
                    );

                    session.pendingTimer = null;
                }

                if (session.isPending) {
                    pendingSessions.delete(
                        cleanNumber
                    );

                    session.isPending = false;

                    // sessionFolder is already the permanent auth folder. Do not
                    // rename it while the active Baileys socket is using its key store.
                    sessionsConfig[
                        cleanNumber
                    ] = {
                        label: session.label,
                        protectionEnabled:
                            session.protectionEnabled
                    };

                    saveSessionsConfig();

                    linkedSessions.set(
                        cleanNumber,
                        session
                    );

                    console.log(
                        `[SESSION] ${cleanNumber} is now officially registered.`
                    );

                    if (
                        session.requesterSock &&
                        session.requesterJid
                    ) {
                        await sendCommandText(
                            session.requesterSock,
                            session.requesterJid,
                            `${BOT_NAME}


🟢 تم اقتران الحساب بنجاح

🏷️ اللقب: ${session.label}
📱 الرقم: ${cleanNumber}
🛡️ الحماية: ${session.protectionEnabled ? "مفعلة" : "متوقفة"}

🎖️ الحساب أصبح وحدة رسمية ضمن النظام.
⚔️ الجلسة محفوظة رسميًا.`
                        );
                    }
                }

                return;
            }

            // ======================
            // 🔴 CLOSE
            // ======================

            if (connection !== "close") {
                return;
            }

            session.connected = false;

            const statusCode =
                lastDisconnect
                    ?.error
                    ?.output
                    ?.statusCode;

            console.log(
                `[SESSION] ${cleanNumber} disconnected. Code: ${statusCode}`
            );

            // ======================
            // ⏳ PENDING SESSION
            // ======================

            if (session.isPending) {
                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {
                    console.log(
                        `[PAIRING] ${cleanNumber} received 401. No automatic re-pairing or session deletion.`
                    );

                    pendingSessions.delete(
                        cleanNumber
                    );

                    if (session.pendingTimer) {
                        clearTimeout(session.pendingTimer);
                        session.pendingTimer = null;
                    }

                    try {
                        sock.end();
                    } catch {}

                    return;
                }

                // إذا أصبحت الجلسة مسجلة أثناء الاقتران، نسمح بإعادة الاتصال
                // بالأخطاء المؤقتة فقط وبدون طلب كود اقتران جديد.
                if (state.creds.registered) {
                    if (session.reconnectScheduled) {
                        return;
                    }

                    await linkedCredsSavePromise.catch(() => undefined);

                    session.reconnectScheduled = true;

                    console.log(
                        `[PAIRING] Session is registered. Restarting connection for ${cleanNumber}...`
                    );

                    restartPendingSession(
                        session
                    ).catch(error => {
                        session.reconnectScheduled = false;
                        console.error(
                            "[PAIRING] Registered restart error:",
                            error?.message || error
                        );
                    });

                    return;
                }

                // قبل اكتمال الاقتران، لا نعيد طلب كود جديد تلقائيًا.
                console.log(
                    `[PAIRING] Pending pairing closed. No automatic new code. Code: ${statusCode}`
                );

                pendingSessions.delete(
                    cleanNumber
                );

                if (session.pendingTimer) {
                    clearTimeout(session.pendingTimer);
                    session.pendingTimer = null;
                }

                try {
                    sock.end();
                } catch {}

                return;
            }

            // ======================
            // 🗑️ DELETING
            // ======================

            if (session.deleting) {
                return;
            }

            // ======================
            // 🚪 LOGGED OUT / 401
            // ======================

            if (
                statusCode ===
                DisconnectReason.loggedOut
            ) {
                session.authInvalid = true;

                console.log(
                    `[LINKED] ${cleanNumber} returned 401. Session kept, no automatic reconnect.`
                );

                try {
                    sock.end();
                } catch {}

                return;
            }

            if (session.reconnectScheduled) {
                return;
            }

            session.reconnectScheduled = true;

            console.log(
                `[LINKED] Reconnecting ${cleanNumber}...`
            );

            linkedSessions.delete(
                cleanNumber
            );

            const reconnectAttempt = Number(linkedReconnectAttempts.get(cleanNumber) || 0);
            const requestedDelay = statusCode === 515 ? 350 : statusCode === 408 ? 1200 : 1500;
            const backoffDelay = Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(reconnectAttempt, 6)));
            const reconnectDelay = Math.max(requestedDelay, backoffDelay) + Math.floor(Math.random() * 1200);
            linkedReconnectAttempts.set(cleanNumber, reconnectAttempt + 1);

            console.log(`[LINKED] Reconnect scheduled in ${reconnectDelay}ms | attempt=${reconnectAttempt + 1} | ${cleanNumber}`);
            scheduleLinkedAccountReconnect(
                cleanNumber,
                session.label,
                reconnectDelay,
                `connection close ${statusCode ?? 'unknown'}`,
                reconnectAttempt + 1
            );
        }
    );

    // ==========================
    // 💬 LINKED MESSAGES
    // ==========================

    sock.ev.on(
        "messages.upsert",
        async ({ messages, type }) => {
            session.lastHealthActivityAt = Date.now();
            session.healthStaleCount = 0;

            const batch = messages || [];

            console.log(
                `[INBOX][${cleanNumber}] messages.upsert | type=${type} | count=${batch.length}`
            );

            if (type !== "notify") {
                console.log(
                    `[INBOX][${cleanNumber}] تجاهل الحدث لأن نوعه ليس notify: ${type}`
                );
                return;
            }

            for (const msg of batch) {
                void handleMessage(session, msg).catch(error => {
                    logMessageHandlerError('[LINKED MESSAGE ERROR]', error, session);
                });
            }
        }
    );

    // نفس آلية الكود القديم: إنشاء الsocket ثم الانتظار 1500ms وطلب الكود مرة واحدة.
    if (isNewPairing && !state.creds.registered) {
        setTimeout(async () => {
            try {
                if (session.deleting || !session.isPending || state.creds.registered) {
                    return;
                }

                const code = await sock.requestPairingCode(cleanNumber);
                const formattedCode =
                    String(code).match(/.{1,4}/g)?.join("-") || code;

                console.log("");
                console.log("========================================");
                console.log(`${BOT_NAME}`);
                console.log(`🏷️ LABEL: ${session.label}`);
                console.log(`📱 LINKED NUMBER: ${cleanNumber}`);
                console.log(`🔐 PAIRING CODE: ${formattedCode}`);
                console.log("========================================");
                console.log("");

                if (session.requesterSock && session.requesterJid) {
                    await sendCommandText(
                        session.requesterSock,
                        session.requesterJid,
                        `${BOT_NAME}


🔐 تفاصيل الاقتران

🏷️ اللقب: ${session.label}
📱 الرقم: ${cleanNumber}

🔑 كود الاقتران:

${formattedCode}



📲 افتح واتساب في الرقم أعلاه:
الإعدادات
↳ الأجهزة المرتبطة
↳ ربط جهاز
↳ الربط باستخدام رقم الهاتف

⚠️ لا تشارك الكود مع أي شخص.
⏳ الحساب لا يصبح وحدة رسمية إلا بعد نجاح الاقتران فعليًا.`
                    );
                }
            } catch (error) {
                console.error(
                    "[PAIRING] Failed requesting linked code:",
                    error?.message || error
                );
            }
        }, 1500);
    }
    } finally {
        startingLinkedAccounts.delete(cleanNumber);
    }
}

// ==============================
// 🗑️ DELETE LINKED ACCOUNT
// ==============================

async function deleteLinkedAccount(
    label,
    requesterSession,
    requesterJid
) {
    const wantedLabel =
        String(label || "")
            .trim()
            .toLowerCase();

    if (!wantedLabel) {
        return;
    }

    let targetNumber = null;
    let targetSession = null;

    for (const [number, session] of linkedSessions.entries()) {
        if (
            String(session.label)
                .trim()
                .toLowerCase() === wantedLabel
        ) {
            targetNumber = number;
            targetSession = session;
            break;
        }
    }

    if (!targetSession) {
        for (const [number, session] of pendingSessions.entries()) {
            if (
                String(session.label)
                    .trim()
                    .toLowerCase() === wantedLabel
            ) {
                targetNumber = number;
                targetSession = session;
                break;
            }
        }
    }

    if (!targetSession) {
        await sendCommandText(
            requesterSession.sock,
            requesterJid,
            `${BOT_NAME}


❌ لم يتم العثور على وحدة بهذا اللقب:

🏷️ ${label}`
        );

        return;
    }

    targetSession.deleting = true;

    if (pendingSessions.has(targetNumber)) {
        pendingSessions.delete(
            targetNumber
        );

        if (targetSession.pendingTimer) {
            clearTimeout(
                targetSession.pendingTimer
            );
        }

        try {
            targetSession.sock.end();
        } catch {}

        removeFolder(getSessionFolder(targetNumber));

        await sendCommandText(
            requesterSession.sock,
            requesterJid,
            `${BOT_NAME}


🗑️ تم إلغاء طلب الاقتران.

🏷️ اللقب: ${targetSession.label}
📱 الرقم: ${targetNumber}

⏳ الوحدة لم تكن مرتبطة رسميًا.`
        );

        return;
    }

    linkedSessions.delete(
        targetNumber
    );

    delete sessionsConfig[
        targetNumber
    ];

    saveSessionsConfig();

    try {
        await targetSession.sock.logout();
    } catch {}

    removeFolder(
        getSessionFolder(targetNumber)
    );

    await sendCommandText(
        requesterSession.sock,
        requesterJid,
        `${BOT_NAME}


🗑️ تم حذف الوحدة بنجاح

🏷️ اللقب: ${targetSession.label}
📱 الرقم: ${targetNumber}

🔌 تم فصل الحساب من النظام.
💾 تم حذف بيانات الجلسة.
🎖️ لم تعد الوحدة ضمن مشرفي النظام.`
    );
}

// ==============================
// 🪖 INSTALL / UNINSTALL
// ==============================

async function handleInstallCommand(
    session,
    jid,
    senderNumber,
    command,
    msg
) {
    if (!(await isAuthorizedModerator(session, jid, senderNumber))) {
        if (claimCommand(msg, session)) {
            await sendAdminOnlyMessage(session, jid);
        }

        return true;
    }

    if (!claimCommand(msg, session)) {
        return true;
    }

    if (command === "$تنصيب") {
        if (isGroupInstalled(jid)) {
            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}


⚠️ القروب منصّب مسبقًا.

🛡️ النظام يعمل داخل هذا القروب.
🎖️ الوحدة في وضع الاستعداد.`
            );

            return true;
        }

        installGroup(jid, senderNumber);

        await sendCommandText(
            session.sock,
            jid,
            `${BOT_NAME}


🟢 تم تنصيب النظام

📡 القروب أصبح ضمن نطاق الحماية.
🛡️ الحماية: مفعلة
⚡ أول Contact = استجابة فورية
🗑️ جميع Contacts اللاحقة أثناء الحادثة تُحذف.

🎖️ من هذه اللحظة، القروب تحت حماية النظام.`
        );

        return true;
    }

    if (command === "$الغاء_تنصيب") {
        if (!isGroupInstalled(jid)) {
            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}


⚠️ هذا القروب غير منصّب أصلًا.

📡 لا توجد مهمة تشغيلية مرتبطة به.`
            );

            return true;
        }

        uninstallGroup(jid);

        await sendCommandText(
            session.sock,
            jid,
            `${BOT_NAME}


🔴 تم إلغاء التنصيب

📡 تم سحب القروب من نطاق الحماية.
🛡️ الحماية داخل هذا القروب: موقفة

🎖️ لا تعود المهمة للعمل هنا إلا بعد تنفيذ:
$تنصيب`
        );

        return true;
    }

    return true;
}

// ==============================
// 🇮🇶 IRAQ TIME HELPERS
// ==============================

function getIraqDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Baghdad",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        hourCycle: "h23"
    }).formatToParts(date);

    const result = {};
    for (const part of parts) {
        if (part.type !== "literal") result[part.type] = part.value;
    }

    return {
        year: Number(result.year),
        month: Number(result.month),
        day: Number(result.day),
        hour: Number(result.hour),
        minute: Number(result.minute)
    };
}

function formatDateKey(year, month, day) {
    return [
        String(year).padStart(4, "0"),
        String(month).padStart(2, "0"),
        String(day).padStart(2, "0")
    ].join("-");
}

function getIraqDateKey(date = new Date()) {
    const parts = getIraqDateParts(date);
    return formatDateKey(parts.year, parts.month, parts.day);
}

// ==============================
// 📿 RELIGIOUS CONTENT
// ==============================

const RELIGIOUS_DUAS = [
    ["رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ", "البقرة 2:201"],
    ["رَبَّنَا لَا تُزِغْ قُلُوبَنَا بَعْدَ إِذْ هَدَيْتَنَا وَهَبْ لَنَا مِنْ لَدُنْكَ رَحْمَةً إِنَّكَ أَنْتَ الْوَهَّابُ", "آل عمران 3:8"],
    ["رَبَّنَا أَفْرِغْ عَلَيْنَا صَبْرًا وَتَوَفَّنَا مُسْلِمِينَ", "الأعراف 7:126"],
    ["رَبِّ اشْرَحْ لِي صَدْرِي ۝ وَيَسِّرْ لِي أَمْرِي", "طه 20:25-26"],
    ["رَبِّ زِدْنِي عِلْمًا", "طه 20:114"],
    ["لَا إِلَهَ إِلَّا أَنْتَ سُبْحَانَكَ إِنِّي كُنْتُ مِنَ الظَّالِمِينَ", "الأنبياء 21:87"],
    ["رَبِّ إِنِّي لِمَا أَنْزَلْتَ إِلَيَّ مِنْ خَيْرٍ فَقِيرٌ", "القصص 28:24"],
    ["رَبَّنَا ظَلَمْنَا أَنْفُسَنَا وَإِنْ لَمْ تَغْفِرْ لَنَا وَتَرْحَمْنَا لَنَكُونَنَّ مِنَ الْخَاسِرِينَ", "الأعراف 7:23"],
    ["رَبِّ اغْفِرْ لِي وَلِوَالِدَيَّ وَلِمَنْ دَخَلَ بَيْتِيَ مُؤْمِنًا وَلِلْمُؤْمِنِينَ وَالْمُؤْمِنَاتِ", "نوح 71:28"],
    ["رَبَّنَا اغْفِرْ لَنَا وَلِإِخْوَانِنَا الَّذِينَ سَبَقُونَا بِالْإِيمَانِ", "الحشر 59:10"],
    ["رَبِّ أَعُوذُ بِكَ أَنْ أَسْأَلَكَ مَا لَيْسَ لِي بِهِ عِلْمٌ", "هود 11:47"],
    ["رَبَّنَا لَا تُؤَاخِذْنَا إِنْ نَسِينَا أَوْ أَخْطَأْنَا", "البقرة 2:286"],
    ["رَبَّنَا وَلَا تَحْمِلْ عَلَيْنَا إِصْرًا كَمَا حَمَلْتَهُ عَلَى الَّذِينَ مِنْ قَبْلِنَا", "البقرة 2:286"],
    ["رَبَّنَا وَلَا تُحَمِّلْنَا مَا لَا طَاقَةَ لَنَا بِهِ وَاعْفُ عَنَّا وَاغْفِرْ لَنَا وَارْحَمْنَا", "البقرة 2:286"],
    ["رَبِّ اجْعَلْنِي مُقِيمَ الصَّلَاةِ وَمِنْ ذُرِّيَّتِي رَبَّنَا وَتَقَبَّلْ دُعَاءِ", "إبراهيم 14:40"],
    ["رَبَّنَا اغْفِرْ لِي وَلِوَالِدَيَّ وَلِلْمُؤْمِنِينَ يَوْمَ يَقُومُ الْحِسَابُ", "إبراهيم 14:41"],
    ["رَبِّ أَوْزِعْنِي أَنْ أَشْكُرَ نِعْمَتَكَ الَّتِي أَنْعَمْتَ عَلَيَّ وَعَلَى وَالِدَيَّ", "النمل 27:19"],
    ["رَبَّنَا هَبْ لَنَا مِنْ أَزْوَاجِنَا وَذُرِّيَّاتِنَا قُرَّةَ أَعْيُنٍ وَاجْعَلْنَا لِلْمُتَّقِينَ إِمَامًا", "الفرقان 25:74"],
    ["رَبِّ نَجِّنِي مِنَ الْقَوْمِ الظَّالِمِينَ", "القصص 28:21"],
    ["رَبَّنَا عَلَيْكَ تَوَكَّلْنَا وَإِلَيْكَ أَنَبْنَا وَإِلَيْكَ الْمَصِيرُ", "الممتحنة 60:4"],
    ["رَبَّنَا أَتْمِمْ لَنَا نُورَنَا وَاغْفِرْ لَنَا إِنَّكَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ", "التحريم 66:8"],
    ["رَبِّ هَبْ لِي مِنْ لَدُنْكَ ذُرِّيَّةً طَيِّبَةً إِنَّكَ سَمِيعُ الدُّعَاءِ", "آل عمران 3:38"],
    ["رَبِّ لَا تَذَرْنِي فَرْدًا وَأَنْتَ خَيْرُ الْوَارِثِينَ", "الأنبياء 21:89"],
    ["رَبِّ هَبْ لِي حُكْمًا وَأَلْحِقْنِي بِالصَّالِحِينَ", "الشعراء 26:83"],
    ["رَبِّ اجْعَلْنِي مُقِيمَ الصَّلَاةِ وَمِنْ ذُرِّيَّتِي", "إبراهيم 14:40"],
    ["رَبِّ أَدْخِلْنِي مُدْخَلَ صِدْقٍ وَأَخْرِجْنِي مُخْرَجَ صِدْقٍ وَاجْعَلْ لِي مِنْ لَدُنْكَ سُلْطَانًا نَصِيرًا", "الإسراء 17:80"],
    ["رَبِّ أَعُوذُ بِكَ مِنْ هَمَزَاتِ الشَّيَاطِينِ ۝ وَأَعُوذُ بِكَ رَبِّ أَنْ يَحْضُرُونِ", "المؤمنون 23:97-98"],
    ["رَبَّنَا آمَنَّا فَاغْفِرْ لَنَا ذُنُوبَنَا وَقِنَا عَذَابَ النَّارِ", "آل عمران 3:16"],
    ["رَبَّنَا أَفْرِغْ عَلَيْنَا صَبْرًا وَثَبِّتْ أَقْدَامَنَا وَانْصُرْنَا عَلَى الْقَوْمِ الْكَافِرِينَ", "البقرة 2:250"],
    ["رَبِّ اغْفِرْ وَارْحَمْ وَأَنْتَ خَيْرُ الرَّاحِمِينَ", "المؤمنون 23:118"],
    ["رَبَّنَا تَقَبَّلْ مِنَّا إِنَّكَ أَنْتَ السَّمِيعُ الْعَلِيمُ", "البقرة 2:127"],
    ["رَبَّنَا عَلَيْكَ تَوَكَّلْنَا وَإِلَيْكَ أَنَبْنَا وَإِلَيْكَ الْمَصِيرُ", "الممتحنة 60:4"],
    ["رَبِّ أَدْخِلْنِي مُدْخَلَ صِدْقٍ وَأَخْرِجْنِي مُخْرَجَ صِدْقٍ", "الإسراء 17:80"],
    ["رَبَّنَا هَبْ لَنَا مِنْ لَدُنْكَ رَحْمَةً وَهَيِّئْ لَنَا مِنْ أَمْرِنَا رَشَدًا", "الكهف 18:10"],
    ["رَبِّ اغْفِرْ لِي وَلِوَالِدَيَّ وَلِلْمُؤْمِنِينَ يَوْمَ يَقُومُ الْحِسَابُ", "إبراهيم 14:41"],
    ["اللَّهُمَّ إِنِّي أَسْأَلُكَ الْهُدَى وَالتُّقَى وَالْعَفَافَ وَالْغِنَى", "صحيح مسلم 2721"]
];

const QURAN_AYAT = [
    ["بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ ۝ الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ ۝ الرَّحْمَٰنِ الرَّحِيمِ ۝ مَالِكِ يَوْمِ الدِّينِ ۝ إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ ۝ اهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ ۝ صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّالِّينَ", "الفاتحة 1:1-7"],
    ["اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ ۚ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ ۚ لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ ۗ مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ ۚ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ ۖ وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءَ ۚ وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضَ ۖ وَلَا يَئُودُهُ حِفْظُهُمَا ۚ وَهُوَ الْعَلِيُّ الْعَظِيمُ", "البقرة 2:255"],
    ["ءَامَنَ الرَّسُولُ بِمَا أُنزِلَ إِلَيْهِ مِن رَّبِّهِ وَالْمُؤْمِنُونَ ۚ كُلٌّ آمَنَ بِاللَّهِ وَمَلَائِكَتِهِ وَكُتُبِهِ وَرُسُلِهِ لَا نُفَرِّقُ بَيْنَ أَحَدٍ مِّن رُّسُلِهِ ۚ وَقَالُوا سَمِعْنَا وَأَطَعْنَا ۖ غُفْرَانَكَ رَبَّنَا وَإِلَيْكَ الْمَصِيرُ ۝ لَا يُكَلِّفُ اللَّهُ نَفْسًا إِلَّا وُسْعَهَا ۚ لَهَا مَا كَسَبَتْ وَعَلَيْهَا مَا اكْتَسَبَتْ ۗ رَبَّنَا لَا تُؤَاخِذْنَا إِن نَّسِينَا أَوْ أَخْطَأْنَا ۚ رَبَّنَا وَلَا تَحْمِلْ عَلَيْنَا إِصْرًا كَمَا حَمَلْتَهُ عَلَى الَّذِينَ مِن قَبْلِنَا ۚ رَبَّنَا وَلَا تُحَمِّلْنَا مَا لَا طَاقَةَ لَنَا بِهِ ۖ وَاعْفُ عَنَّا وَاغْفِرْ لَنَا وَارْحَمْنَا ۚ أَنتَ مَوْلَانَا فَانصُرْنَا عَلَى الْقَوْمِ الْكَافِرِينَ", "البقرة 2:285-286"],
    ["إِنَّ فِي خَلْقِ السَّمَاوَاتِ وَالْأَرْضِ وَاخْتِلَافِ اللَّيْلِ وَالنَّهَارِ لَآيَاتٍ لِّأُولِي الْأَلْبَابِ ۝ الَّذِينَ يَذْكُرُونَ اللَّهَ قِيَامًا وَقُعُودًا وَعَلَىٰ جُنُوبِهِمْ وَيَتَفَكَّرُونَ فِي خَلْقِ السَّمَاوَاتِ وَالْأَرْضِ رَبَّنَا مَا خَلَقْتَ هَٰذَا بَاطِلًا سُبْحَانَكَ فَقِنَا عَذَابَ النَّارِ ۝ رَبَّنَا إِنَّكَ مَن تُدْخِلِ النَّارَ فَقَدْ أَخْزَيْتَهُ وَمَا لِلظَّالِمِينَ مِنْ أَنصَارٍ ۝ رَبَّنَا إِنَّنَا سَمِعْنَا مُنَادِيًا يُنَادِي لِلْإِيمَانِ أَنْ آمِنُوا بِرَبِّكُمْ فَآمَنَّا ۚ رَبَّنَا فَاغْفِرْ لَنَا ذُنُوبَنَا وَكَفِّرْ عَنَّا سَيِّئَاتِنَا وَتَوَفَّنَا مَعَ الْأَبْرَارِ ۝ رَبَّنَا وَآتِنَا مَا وَعَدتَّنَا عَلَىٰ رُسُلِكَ وَلَا تُخْزِنَا يَوْمَ الْقِيَامَةِ ۗ إِنَّكَ لَا تُخْلِفُ الْمِيعَادَ", "آل عمران 3:190-194"],
    ["وَبَشِّرِ الصَّابِرِينَ ۝ الَّذِينَ إِذَا أَصَابَتْهُم مُّصِيبَةٌ قَالُوا إِنَّا لِلَّهِ وَإِنَّا إِلَيْهِ رَاجِعُونَ ۝ أُولَٰئِكَ عَلَيْهِمْ صَلَوَاتٌ مِّن رَّبِّهِمْ وَرَحْمَةٌ ۖ وَأُولَٰئِكَ هُمُ الْمُهْتَدُونَ", "البقرة 2:155-157"],
    ["وَإِذَا سَأَلَكَ عِبَادِي عَنِّي فَإِنِّي قَرِيبٌ ۖ أُجِيبُ دَعْوَةَ الدَّاعِ إِذَا دَعَانِ ۖ فَلْيَسْتَجِيبُوا لِي وَلْيُؤْمِنُوا بِي لَعَلَّهُمْ يَرْشُدُونَ", "البقرة 2:186"],
    ["وَمَن يَتَّقِ اللَّهَ يَجْعَل لَّهُ مَخْرَجًا ۝ وَيَرْزُقْهُ مِنْ حَيْثُ لَا يَحْتَسِبُ ۚ وَمَن يَتَوَكَّلْ عَلَى اللَّهِ فَهُوَ حَسْبُهُ ۚ إِنَّ اللَّهَ بَالِغُ أَمْرِهِ ۚ قَدْ جَعَلَ اللَّهُ لِكُلِّ شَيْءٍ قَدْرًا", "الطلاق 65:2-3"],
    ["إِنَّ اللَّهَ مَعَ الَّذِينَ اتَّقَوا وَالَّذِينَ هُم مُّحْسِنُونَ ۝ وَالَّذِينَ جَاهَدُوا فِينَا لَنَهْدِيَنَّهُمْ سُبُلَنَا ۚ وَإِنَّ اللَّهَ لَمَعَ الْمُحْسِنِينَ", "النحل 16:128، العنكبوت 29:69"],
    ["وَقُل رَّبِّ زِدْنِي عِلْمًا ۝ وَقُل رَّبِّ أَعُوذُ بِكَ مِنْ هَمَزَاتِ الشَّيَاطِينِ ۝ وَأَعُوذُ بِكَ رَبِّ أَن يَحْضُرُونِ", "طه 20:114، المؤمنون 23:97-98"],
    ["وَقُل رَّبِّ ارْحَمْهُمَا كَمَا رَبَّيَانِي صَغِيرًا ۝ رَّبُّكُمْ أَعْلَمُ بِمَا فِي نُفُوسِكُمْ ۚ إِن تَكُونُوا صَالِحِينَ فَإِنَّهُ كَانَ لِلْأَوَّابِينَ غَفُورًا", "الإسراء 17:24-25"],
    ["وَمَا تَوْفِيقِي إِلَّا بِاللَّهِ ۚ عَلَيْهِ تَوَكَّلْتُ وَإِلَيْهِ أُنِيبُ ۝ وَيَا قَوْمِ لَا يَجْرِمَنَّكُمْ شِقَاقِي أَن يُصِيبَكُم مِّثْلُ مَا أَصَابَ قَوْمَ نُوحٍ أَوْ قَوْمَ هُودٍ أَوْ قَوْمَ صَالِحٍ ۚ وَمَا قَوْمُ لُوطٍ مِّنكُم بِبَعِيدٍ", "هود 11:88-89"],
    ["لَقَدْ جَاءَكُمْ رَسُولٌ مِّنْ أَنفُسِكُمْ عَزِيزٌ عَلَيْهِ مَا عَنِتُّمْ حَرِيصٌ عَلَيْكُم بِالْمُؤْمِنِينَ رَءُوفٌ رَّحِيمٌ ۝ فَإِن تَوَلَّوْا فَقُلْ حَسْبِيَ اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ ۖ عَلَيْهِ تَوَكَّلْتُ وَهُوَ رَبُّ الْعَرْشِ الْعَظِيمِ", "التوبة 9:128-129"],
    ["وَالضُّحَى ۝ وَاللَّيْلِ إِذَا سَجَى ۝ مَا وَدَّعَكَ رَبُّكَ وَمَا قَلَى ۝ وَلَلْآخِرَةُ خَيْرٌ لَّكَ مِنَ الْأُولَى ۝ وَلَسَوْفَ يُعْطِيكَ رَبُّكَ فَتَرْضَى ۝ أَلَمْ يَجِدْكَ يَتِيمًا فَآوَى ۝ وَوَجَدَكَ ضَالًّا فَهَدَى ۝ وَوَجَدَكَ عَائِلًا فَأَغْنَى", "الضحى 93:1-8"],
    ["أَلَمْ نَشْرَحْ لَكَ صَدْرَكَ ۝ وَوَضَعْنَا عَنكَ وِزْرَكَ ۝ الَّذِي أَنقَضَ ظَهْرَكَ ۝ وَرَفَعْنَا لَكَ ذِكْرَكَ ۝ فَإِنَّ مَعَ الْعُسْرِ يُسْرًا ۝ إِنَّ مَعَ الْعُسْرِ يُسْرًا ۝ فَإِذَا فَرَغْتَ فَانصَبْ ۝ وَإِلَىٰ رَبِّكَ فَارْغَب", "الشرح 94:1-8"],
    ["قُلْ هُوَ اللَّهُ أَحَدٌ ۝ اللَّهُ الصَّمَدُ ۝ لَمْ يَلِدْ وَلَمْ يُولَدْ ۝ وَلَمْ يَكُن لَّهُ كُفُوًا أَحَدٌ", "الإخلاص 112:1-4"],
    ["قُلْ أَعُوذُ بِرَبِّ الْفَلَقِ ۝ مِن شَرِّ مَا خَلَقَ ۝ وَمِن شَرِّ غَاسِقٍ إِذَا وَقَبَ ۝ وَمِن شَرِّ النَّفَّاثَاتِ فِي الْعُقَدِ ۝ وَمِن شَرِّ حَاسِدٍ إِذَا حَسَدَ", "الفلق 113:1-5"],
    ["قُلْ أَعُوذُ بِرَبِّ النَّاسِ ۝ مَلِكِ النَّاسِ ۝ إِلَٰهِ النَّاسِ ۝ مِن شَرِّ الْوَسْوَاسِ الْخَنَّاسِ ۝ الَّذِي يُوَسْوِسُ فِي صُدُورِ النَّاسِ ۝ مِنَ الْجِنَّةِ وَالنَّاسِ", "الناس 114:1-6"],
    ["وَعِبَادُ الرَّحْمَٰنِ الَّذِينَ يَمْشُونَ عَلَى الْأَرْضِ هَوْنًا وَإِذَا خَاطَبَهُمُ الْجَاهِلُونَ قَالُوا سَلَامًا ۝ وَالَّذِينَ يَبِيتُونَ لِرَبِّهِمْ سُجَّدًا وَقِيَامًا ۝ وَالَّذِينَ يَقُولُونَ رَبَّنَا اصْرِفْ عَنَّا عَذَابَ جَهَنَّمَ إِنَّ عَذَابَهَا كَانَ غَرَامًا ۝ إِنَّهَا سَاءَتْ مُسْتَقَرًّا وَمُقَامًا", "الفرقان 25:63-66"],
    ["إِنَّ الَّذِينَ قَالُوا رَبُّنَا اللَّهُ ثُمَّ اسْتَقَامُوا تَتَنَزَّلُ عَلَيْهِمُ الْمَلَائِكَةُ أَلَّا تَخَافُوا وَلَا تَحْزَنُوا وَأَبْشِرُوا بِالْجَنَّةِ الَّتِي كُنتُمْ تُوعَدُونَ ۝ نَحْنُ أَوْلِيَاؤُكُمْ فِي الْحَيَاةِ الدُّنْيَا وَفِي الْآخِرَةِ ۖ وَلَكُمْ فِيهَا مَا تَشْتَهِي أَنفُسُكُمْ وَلَكُمْ فِيهَا مَا تَدَّعُونَ ۝ نُزُلًا مِّنْ غَفُورٍ رَّحِيمٍ", "فصلت 41:30-32"],
    ["إِنَّ الْإِنسَانَ لَفِي خُسْرٍ ۝ إِلَّا الَّذِينَ آمَنُوا وَعَمِلُوا الصَّالِحَاتِ وَتَوَاصَوْا بِالْحَقِّ وَتَوَاصَوْا بِالصَّبْرِ", "العصر 103:1-3"],
    ["فَاذْكُرُونِي أَذْكُرْكُمْ وَاشْكُرُوا لِي وَلَا تَكْفُرُونِ ۝ يَا أَيُّهَا الَّذِينَ آمَنُوا اسْتَعِينُوا بِالصَّبْرِ وَالصَّلَاةِ ۚ إِنَّ اللَّهَ مَعَ الصَّابِرِينَ", "البقرة 2:152-153"],
    ["إِنَّ اللَّهَ لَا يُضِيعُ أَجْرَ الْمُحْسِنِينَ ۝ وَأَقِيمُوا الصَّلَاةَ وَآتُوا الزَّكَاةَ ۚ وَمَا تُقَدِّمُوا لِأَنفُسِكُم مِّنْ خَيْرٍ تَجِدُوهُ عِندَ اللَّهِ ۗ إِنَّ اللَّهَ بِمَا تَعْمَلُونَ بَصِيرٌ", "البقرة 2:110-112"],
    ["وَمَن يَتَّقِ اللَّهَ يَجْعَل لَّهُ مِنْ أَمْرِهِ يُسْرًا ۝ ذَٰلِكَ أَمْرُ اللَّهِ أَنزَلَهُ إِلَيْكُمْ ۚ وَمَن يَتَّقِ اللَّهَ يُكَفِّرْ عَنْهُ سَيِّئَاتِهِ وَيُعْظِمْ لَهُ أَجْرًا", "الطلاق 65:4-5"],
    ["أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ", "الرعد 13:28"],
    ["فَإِنَّ مَعَ الْعُسْرِ يُسْرًا ۝ إِنَّ مَعَ الْعُسْرِ يُسْرًا", "الشرح 94:5-6"],
    ["وَقُلْ جَاءَ الْحَقُّ وَزَهَقَ الْبَاطِلُ إِنَّ الْبَاطِلَ كَانَ زَهُوقًا", "الإسراء 17:81"],
    ["وَهُوَ مَعَكُمْ أَيْنَ مَا كُنْتُمْ وَاللَّهُ بِمَا تَعْمَلُونَ بَصِيرٌ", "الحديد 57:4"],
    ["إِنَّ اللَّهَ يُحِبُّ الْمُحْسِنِينَ", "البقرة 2:195"],
    ["وَمَا تَوْفِيقِي إِلَّا بِاللَّهِ عَلَيْهِ تَوَكَّلْتُ وَإِلَيْهِ أُنِيبُ", "هود 11:88"]
];

const SAHIH_HADITH = [
    ["إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ، وَإِنَّمَا لِكُلِّ امْرِئٍ مَا نَوَى", "صحيح البخاري 1"],
    ["الْمُسْلِمُ مَنْ سَلِمَ الْمُسْلِمُونَ مِنْ لِسَانِهِ وَيَدِهِ", "صحيح البخاري 10"],
    ["لا يُؤْمِنُ أَحَدُكُمْ حَتَّى يُحِبَّ لأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ", "صحيح البخاري 13"],
    ["مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ", "صحيح البخاري 6018، صحيح مسلم 47b"],
    ["مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الآخِرِ فَلَا يُؤْذِ جَارَهُ", "صحيح البخاري 6018، صحيح مسلم 47b"],
    ["مَنْ لَا يَرْحَمُ لَا يُرْحَمُ", "صحيح البخاري 6013"],
    ["أَحَبُّ الأَعْمَالِ إِلَى اللَّهِ أَدْوَمُهَا وَإِنْ قَلَّ", "صحيح البخاري 6464، صحيح مسلم 783b"],
    ["مَا نَقَصَتْ صَدَقَةٌ مِنْ مَالٍ، وَمَا زَادَ اللَّهُ عَبْدًا بِعَفْوٍ إِلَّا عِزًّا", "صحيح مسلم 2588"],
    ["الْمُسْلِمُ أَخُو الْمُسْلِمِ، لَا يَظْلِمُهُ وَلَا يَخْذُلُهُ وَلَا يَحْقِرُهُ", "صحيح مسلم 2564a"],
    ["لَا تَبَاغَضُوا وَلَا تَحَاسَدُوا وَلَا تَدَابَرُوا وَكُونُوا عِبَادَ اللَّهِ إِخْوَانًا", "صحيح مسلم 2558b"],
    ["مَنْ نَفَّسَ عَنْ مُؤْمِنٍ كُرْبَةً مِنْ كُرَبِ الدُّنْيَا نَفَّسَ اللَّهُ عَنْهُ كُرْبَةً مِنْ كُرَبِ يَوْمِ الْقِيَامَةِ", "صحيح مسلم 2699a"],
    ["وَمَنْ يَسَّرَ عَلَى مُعْسِرٍ يَسَّرَ اللَّهُ عَلَيْهِ فِي الدُّنْيَا وَالْآخِرَةِ", "صحيح مسلم 2699a"],
    ["وَاللَّهُ فِي عَوْنِ الْعَبْدِ مَا كَانَ الْعَبْدُ فِي عَوْنِ أَخِيهِ", "صحيح مسلم 2699a"],
    ["مَنْ سَلَكَ طَرِيقًا يَلْتَمِسُ فِيهِ عِلْمًا سَهَّلَ اللَّهُ لَهُ بِهِ طَرِيقًا إِلَى الْجَنَّةِ", "صحيح مسلم 2699a"],
    ["الطُّهُورُ شَطْرُ الإِيمَانِ، وَالْحَمْدُ لِلَّهِ تَمْلَأُ الْمِيزَانَ", "صحيح مسلم 223"],
    ["يَسِّرُوا وَلَا تُعَسِّرُوا، وَبَشِّرُوا وَلَا تُنَفِّرُوا", "صحيح البخاري وصحيح مسلم"],
    ["مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الآخِرِ فَلْيُكْرِمْ ضَيْفَهُ", "صحيح البخاري 6018، صحيح مسلم 47b"],
    ["إِنَّ اللَّهَ لَا يَنْظُرُ إِلَى صُوَرِكُمْ وَأَمْوَالِكُمْ وَلَكِنْ يَنْظُرُ إِلَى قُلُوبِكُمْ وَأَعْمَالِكُمْ", "صحيح مسلم 2564c"],
    ["لَيْسَ الشَّدِيدُ بِالصُّرَعَةِ، إِنَّمَا الشَّدِيدُ الَّذِي يَمْلِكُ نَفْسَهُ عِنْدَ الْغَضَبِ", "صحيح البخاري 6114، صحيح مسلم 2609"],
    ["إِنَّ اللَّهَ جَمِيلٌ يُحِبُّ الْجَمَالَ، الْكِبْرُ بَطَرُ الْحَقِّ وَغَمْطُ النَّاسِ", "صحيح مسلم 91"],
    ["مَنْ غَشَّنَا فَلَيْسَ مِنَّا", "صحيح مسلم 101"],
    ["لَا يَدْخُلُ الْجَنَّةَ قَاطِعٌ", "صحيح البخاري 5984، صحيح مسلم 2556"],
    ["مَنْ لَا يَرْحَمُ النَّاسَ لَا يَرْحَمْهُ اللَّهُ", "صحيح البخاري 7376، صحيح مسلم 2319"],
    ["الْكَلِمَةُ الطَّيِّبَةُ صَدَقَةٌ", "صحيح البخاري 2989"],
    ["إِمَاطَةُ الأَذَى عَنِ الطَّرِيقِ صَدَقَةٌ", "صحيح البخاري 2827، صحيح مسلم 1009"],
    ["خَيْرُكُمْ خَيْرُكُمْ لأَهْلِهِ، وَأَنَا خَيْرُكُمْ لأَهْلِي", "سنن الترمذي 3895، صحيح"],
    ["الدِّينُ النَّصِيحَةُ", "صحيح مسلم 55"],
    ["الْمُؤْمِنُ لِلْمُؤْمِنِ كَالْبُنْيَانِ يَشُدُّ بَعْضُهُ بَعْضًا", "صحيح البخاري 481، صحيح مسلم 2585"],
    ["الْمَرْءُ مَعَ مَنْ أَحَبَّ", "صحيح البخاري 6169، صحيح مسلم 2640"],
    ["الْمُؤْمِنُ الْقَوِيُّ خَيْرٌ وَأَحَبُّ إِلَى اللَّهِ مِنَ الْمُؤْمِنِ الضَّعِيفِ وَفِي كُلٍّ خَيْرٌ", "صحيح مسلم 2664"],
    ["إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ", "صحيح البخاري 1، صحيح مسلم 1907"],
    ["مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ", "صحيح البخاري 6018، صحيح مسلم 47"],
    ["لَا يُؤْمِنُ أَحَدُكُمْ حَتَّى يُحِبَّ لِأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ", "صحيح البخاري 13، صحيح مسلم 45"],
    ["مَنْ سَلَكَ طَرِيقًا يَلْتَمِسُ فِيهِ عِلْمًا سَهَّلَ اللَّهُ لَهُ بِهِ طَرِيقًا إِلَى الْجَنَّةِ", "صحيح مسلم 2699"],
    ["مَنْ لَا يَشْكُرُ النَّاسَ لَا يَشْكُرُ اللَّهَ", "سنن أبي داود 4811، سنن الترمذي 1954، صحيح"]
];

const MORNING_EVENING_DHIKR = [
    ["سُبْحَانَ اللَّهِ وَبِحَمْدِهِ", "100 مرة في اليوم، تُحَطُّ الخطايا ولو كانت مثل زبد البحر", "صحيح البخاري 6405"],
    ["سُبْحَانَ اللَّهِ وَبِحَمْدِهِ، سُبْحَانَ اللَّهِ الْعَظِيمِ", "ثقيلتان في الميزان وحبيبتان إلى الرحمن", "صحيح البخاري 6682"],
    ["لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ", "100 مرة في اليوم: حرز من الشيطان ومئة حسنة ومئة سيئة تُمحى", "صحيح البخاري 3293"],
    ["سُبْحَانَ اللَّهِ، وَالْحَمْدُ لِلَّهِ، وَلَا إِلَهَ إِلَّا اللَّهُ، وَاللَّهُ أَكْبَرُ", "من أحب الكلام إلى الله", "صحيح مسلم 2137a"],
    ["الْحَمْدُ لِلَّهِ", "تملأ الميزان", "صحيح مسلم 223"],
    ["سُبْحَانَ اللَّهِ وَالْحَمْدُ لِلَّهِ", "تملآن ما بين السماوات والأرض", "صحيح مسلم 223"],
    ["أَسْتَغْفِرُ اللَّهَ وَأَتُوبُ إِلَيْهِ", "ذكر واستغفار، وكان النبي ﷺ يستغفر ويتوب إلى الله", "صحيح البخاري 6307"],
    ["اللَّهُمَّ أَنْتَ رَبِّي لَا إِلَهَ إِلَّا أَنْتَ، خَلَقْتَنِي وَأَنَا عَبْدُكَ...", "سيد الاستغفار، ومن قاله موقنًا به فمات من يومه دخل الجنة", "صحيح البخاري 6306"],
    ["رَضِيتُ بِاللَّهِ رَبًّا، وَبِالإِسْلَامِ دِينًا، وَبِمُحَمَّدٍ رَسُولًا", "ورد في الذكر ثلاث مرات في الصباح والمساء", "سنن أبي داود 5072، الترمذي 3389"],
    ["بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الأَرْضِ وَلَا فِي السَّمَاءِ وَهُوَ السَّمِيعُ الْعَلِيمُ", "ثلاث مرات صباحًا ومساءً، ورد فيه الحفظ من الضرر", "رياض الصالحين 1457"],
    ["أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّاتِ مِنْ شَرِّ مَا خَلَقَ", "ورد في التعوذ من شر ما خلق", "صحيح مسلم، رياض الصالحين 1452"],
    ["اللَّهُمَّ بِكَ أَصْبَحْنَا، وَبِكَ أَمْسَيْنَا، وَبِكَ نَحْيَا، وَبِكَ نَمُوتُ، وَإِلَيْكَ النُّشُورُ", "من أذكار الصباح", "رياض الصالحين 1453"],
    ["اللَّهُمَّ بِكَ أَمْسَيْنَا، وَبِكَ نَحْيَا، وَبِكَ نَمُوتُ، وَإِلَيْكَ الْمَصِيرُ", "من أذكار المساء", "رياض الصالحين 1453"],
    ["اللَّهُمَّ فَاطِرَ السَّمَاوَاتِ وَالأَرْضِ، عَالِمَ الْغَيْبِ وَالشَّهَادَةِ... أَعُوذُ بِكَ مِنْ شَرِّ نَفْسِي وَشَرِّ الشَّيْطَانِ وَشِرْكِهِ", "يقال صباحًا ومساءً وعند النوم", "رياض الصالحين 1454"],
    ["أَمْسَيْنَا وَأَمْسَى الْمُلْكُ لِلَّهِ، وَالْحَمْدُ لِلَّهِ، لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ", "من ذكر المساء", "رياض الصالحين 1455"],
    ["قُلْ هُوَ اللَّهُ أَحَدٌ، وَقُلْ أَعُوذُ بِرَبِّ الْفَلَقِ، وَقُلْ أَعُوذُ بِرَبِّ النَّاسِ", "ثلاث مرات صباحًا ومساءً تكفي من كل شيء", "رياض الصالحين 1456"],
    ["اللَّهُمَّ إِنِّي أَسْأَلُكَ الْعَفْوَ وَالْعَافِيَةَ فِي الدُّنْيَا وَالْآخِرَةِ", "من الدعاء بالعفو والعافية", "سنن أبي داود 5074"],
    ["اللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنَ الْهَمِّ وَالْحَزَنِ، وَأَعُوذُ بِكَ مِنَ الْعَجْزِ وَالْكَسَلِ", "دعاء ثابت للاستعاذة من الهم والعجز والكسل", "صحيح البخاري 6369"],
    ["اللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنْ عِلْمٍ لَا يَنْفَعُ، وَمِنْ قَلْبٍ لَا يَخْشَعُ، وَمِنْ نَفْسٍ لَا تَشْبَعُ، وَمِنْ دَعْوَةٍ لَا يُسْمَعُ لَهَا", "من الدعاء الثابت في الاستعاذة", "صحيح مسلم 2722"],
    ["اللَّهُمَّ أَعِنِّي عَلَى ذِكْرِكَ وَشُكْرِكَ وَحُسْنِ عِبَادَتِكَ", "دعاء يعين على الذكر والشكر وحسن العبادة", "سنن أبي داود 1526"],
    ["رَبِّ اغْفِرْ لِي", "من الاستغفار والدعاء", "صحيح مسلم 484"],
    ["سُبْحَانَ اللَّهِ وَبِحَمْدِهِ عَدَدَ خَلْقِهِ وَرِضَا نَفْسِهِ وَزِنَةَ عَرْشِهِ وَمِدَادَ كَلِمَاتِهِ", "ثلاث مرات، وورد فضل عظيم لهذا الذكر", "رياض الصالحين 1433"],
    ["اللَّهُمَّ صَلِّ وَسَلِّمْ عَلَى مُحَمَّدٍ", "من الصلاة على النبي ﷺ", "وردت فضائل الصلاة عليه في صحيح مسلم 408"],
    ["لَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللَّهِ", "كنز من كنوز الجنة", "صحيح البخاري 6384، صحيح مسلم 2704"],
    ["سُبْحَانَ اللَّهِ وَبِحَمْدِهِ", "من أحب الأذكار إلى الله، وتكرر في أذكار الصباح والمساء", "صحيح مسلم 2691"],
    ["اللَّهُمَّ إِنِّي أَسْأَلُكَ رِضَاكَ وَالْجَنَّةَ وَأَعُوذُ بِكَ مِنْ سَخَطِكَ وَالنَّارِ", "دعاء جامع في سؤال الجنة والاستعاذة من النار", "سنن أبي داود 792"],
    ["اللَّهُمَّ إِنِّي أَسْأَلُكَ الْهُدَى وَالتُّقَى وَالْعَفَافَ وَالْغِنَى", "دعاء جامع للهداية والتقوى والعفاف والغنى", "صحيح مسلم 2721"],
    ["اللَّهُمَّ اغْفِرْ لِي خَطِيئَتِي وَجَهْلِي وَإِسْرَافِي فِي أَمْرِي", "من الدعاء النبوي في صحيح مسلم", "صحيح مسلم 483"],
    ["اللَّهُمَّ اهْدِنِي وَسَدِّدْنِي", "دعاء بالهداية والسداد", "صحيح مسلم 2725"],
    ["اللَّهُمَّ إِنِّي أَسْأَلُكَ الْجَنَّةَ وَأَعُوذُ بِكَ مِنَ النَّارِ", "دعاء ثابت في سؤال الجنة والاستعاذة من النار", "سنن أبي داود 792"],
    ["اللَّهُمَّ إِنِّي أَسْأَلُكَ عِلْمًا نَافِعًا وَرِزْقًا طَيِّبًا وَعَمَلًا مُتَقَبَّلًا", "دعاء يُقال بعد صلاة الفجر", "سنن ابن ماجه 925"],
    ["حَسْبِيَ اللَّهُ لَا إِلَهَ إِلَّا هُوَ عَلَيْهِ تَوَكَّلْتُ وَهُوَ رَبُّ الْعَرْشِ الْعَظِيمِ", "يُقال سبع مرات صباحًا ومساءً في الأثر الوارد", "سنن أبي داود 5081"],
    ["اللَّهُمَّ عَافِنِي فِي بَدَنِي، اللَّهُمَّ عَافِنِي فِي سَمْعِي، اللَّهُمَّ عَافِنِي فِي بَصَرِي", "دعاء بالعافية", "سنن أبي داود 5090"]
];

// ==============================
// 🌐 ONLINE CONTENT + POETRY
// ==============================
// Quran text is fetched live from AlQuran Cloud. Search results for hadith/poetry
// are links/snippets only: verify authenticity and attribution at the original source.
// Local poetry samples are original bot-written lines, not attributed to known poets.
const ORIGINAL_POETRY = {
  iraqi: [
    ["يا صاحبي لو ضاق دربك لا تملّ", "خلّ الأمل بگلبك وخلّ الحزن يرحل"],
    ["مو كل صمتٍ يعني القلب ناسي", "مرات نكتم حچي حتى نعيش بإحساسي"],
    ["الطيب يبقى لو تغيّر زمانه", "والأصل يرفع صاحبه بمكانه"],
    ["لا تنحني للريح لو هبّت هواي", "بعد العسر تضحك لياليك الجاية"],
    ["يا ليل خبرني عن أحلام بعيدة", "وشلون ترجع للروح ضحكتها الجديدة"],
    ["ما هزّني وقتٍ ولا ضاقت بي دروب", "دام الأمل بصدري يردّ الروح حيّه"],
    ["أمشي ولو دربي تعب بيّه الخطاوي", "وأعرف ورا صبر الليالي فرحةٍ جيّه"],
    ["الناس معادن والوفا ما ينشرى", "يبقى الأصيل أصيل لو الدنيا تغيّر"],
    ["لا تشتكي للريح سرّك والوجع", "بعض السوالف سترها أحسن من البوح"],
    ["إن غاب عن عينك عزيزٍ له مقام", "يبقى أثر طيبه على مرّ السنين"],
    ["خلّك كريم النفس لو قلّ النصيب", "ما ينقص الإنسان طيب أخلاقه"],
    ["الوقت يفرز من يحبّك من يمرّ", "والشدّة تكشف لك وجوهٍ مستترة"],
    ["يا صاح لا تحسب تعثّر خطوتك عيب", "كل بداية صعبةٍ تعلّمك دروب"],
    ["من يزرع المعروف يحصد طيب ذكر", "والخير يبقى لو تغيّرت الوجوه"],
    ["خلّ الضمير بصدرك دايم دليل", "لا كل ما يلمع ذهب ولا كل حچي صدگ"]
  ],
  fusha: [
    ["إذا تعثّرَ دربُ المرءِ في أملٍ", "فالصبرُ يفتحُ أبوابًا من الفَرَجِ"],
    ["ولا تظنَّ الليالي لا تفي بوعدٍ", "فالفجرُ يولدُ من أحشاءِ مُنعرَجِ"],
    ["ازرعْ جميلًا وإن ضاقت مسالكُنا", "فالطيبُ يبقى ولو في غيرِ مُنتَهَجِ"],
    ["ومن يصُنْ قلبَهُ بالصدقِ يرفعهُ", "نورُ المروءةِ فوقَ الشكِّ والحرَجِ"],
    ["إذا اشتدَّ ليلُ المرءِ لاحَ تباشُرٌ", "وفي الصبرِ أبوابٌ تفيضُ من الفَرَجِ"],
    ["تأنَّ فإنَّ الدربَ يُدركُ أهلَهُ", "ولا خيرَ في خطوٍ يضيعُ بلا نُضجِ"],
    ["ومن يجعلِ الإحسانَ زادَ مسيرهِ", "يجدْ في قلوبِ الناسِ منزلةَ التاجِ"],
    ["إذا نطقَ الإنسانُ فليزنِ الذي", "يقولُ فكم جرحٍ أتى من فمٍ ساهي"],
    ["تواضعْ فرفعُ المرءِ ليسَ بمالهِ", "ولكنْ بما يبني من الخلقِ والسعي"],
    ["ولا تيأسنْ إن ضاقَ يومٌ بوجههِ", "فكم بعدَ عسرٍ أقبلَ اليسرُ في الغدِ"],
    ["دعِ الحقدَ؛ إنَّ القلبَ يثقلُ حملُهُ", "وسامحْ تجدْ في راحةِ النفسِ موطنا"],
    ["إذا المرءُ أوفى بالعُهودِ فإنَّهُ", "يظلُّ جميلَ الذكرِ في كلِّ موطنِ"],
    ["ومن طلبَ العلياءَ صابرَ دربَهُ", "فإنَّ المعالي لا تُنالُ بتمنّي"]
  ],
  nabati: [
    ["يا صاح لا تقفي على باب الأحزان", "العمر يمضي والفرح له مواعيد"],
    ["خلّ الوفا عنوان في كل الأزمان", "والطيب يبقى لو تغيّرت المقادير"],
    ["إن ضاق صدرك لا تسايرك الأوهام", "ورى عتمة الليل شمسٍ وتباشير"],
    ["يا صاح خلّ الطيب نهجٍ لك عنوان", "ترى المواقف تكشف أهل المعاني"],
    ["ما كل من يضحك صفا قلبه إنسان", "بعض الوجيه تخبّي أسرار ثاني"],
    ["اصبر على الدنيا ولو زاد حرمان", "عقب التعب تفرح عيونٍ تعاني"],
    ["لا تترك المعروف لو قلّ الشكران", "أجر الجميل عند ربّك أماني"],
    ["اللي يصون العهد ما يندم أحيان", "واللي يخون الود يخسر مكانه"],
    ["خلّ الأمل يمشي معك وين ما كان", "يمكن نهارك يمطر أفراح وأغاني"],
    ["بعض السكوت أبلغ من ألف برهان", "وبعض الحكي يترك جروحٍ تداني"],
    ["لا تنحني لو جار وقتك بالأحزان", "ما كل غيمة تحجب النور داني"]
  ],
  wisdom: [
    ["قيمة الإنسان فعلٍ طيبٍ يبقى", "مو بكثرة الحچي ولا زينة الأسماء"],
    ["خلّك على عهدك ولو طال المدى", "الأصل يبان بوقت الشدايد"],
    ["اللي يبني مجده بالصبر والإتقان", "ما تهزّه عواصف يومٍ ولا سنين"],
    ["ليس الغنى جمعَ المقتنياتِ وإنّما", "غنى النفسِ حينَ القلبُ يرضى ويقنعُ"],
    ["إذا أردتَ مقامَ صدقٍ بينَ الورى", "فاجعلْ وفاءَ العهدِ خلقًا يُتّبعُ"],
    ["لا تجعلِ العثراتِ آخرَ رحلةٍ", "فالنورُ يبدأُ حينَ يشتدُّ التعبُ"],
    ["من يصنعِ المعروفَ لا يرجُ الجزا", "يكفيه أن يبقى جميلًا أثرُهُ"],
    ["بالرفقِ تُفتحُ في القلوبِ مغالقٌ", "وبلينِ قولكَ يستريحُ المتعبُ"],
    ["خيرُ الكلامِ إذا تأنّى قائلٌ", "وشرارُهُ لفظٌ يجيءُ ويُندمُ"],
    ["ما قيمةُ الإنسانِ إلا موقفٌ", "عند الشدائدِ يُستبانُ ويُعلمُ"],
    ["ازرعْ صباحكَ بالرجاءِ فإنما", "بعدَ الظلامِ يطلُّ فجرٌ باسمُ"]
  ]
};

function decodeHtmlEntities(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "ArthurWhatsAppBot/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally { clearTimeout(timer); }
}
async function fetchQuranAyah(ayahNumber) {
  const number = Number(ayahNumber);
  if (!Number.isInteger(number) || number < 1 || number > 6236) throw new Error("رقم الآية يجب أن يكون بين 1 و6236");
  const response = await fetchWithTimeout(`https://api.alquran.cloud/v1/ayah/${number}/ar`);
  const data = await response.json();
  if (data?.code !== 200 || !data?.data?.text) throw new Error("تعذّر جلب الآية");
  const ayah = data.data;
  return { text: ayah.text, source: `${ayah.surah?.name || "القرآن الكريم"}، الآية ${ayah.numberInSurah}`, url: `https://alquran.cloud/ayah/${number}` };
}
async function searchWeb(query, siteHint = "") {
  const clean = String(query || "").trim().slice(0, 180);
  if (!clean) return [];
  const fullQuery = `${siteHint ? `site:${siteHint} ` : ""}${clean}`;
  const response = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}`, 12000);
  const html = await response.text();
  const results = [];
  for (const block of html.split(/class="result results_links/).slice(1, 7)) {
    const m = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const sm = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    if (!m) continue;
    let url = decodeHtmlEntities(m[1]);
    const redir = url.match(/[?&]uddg=([^&]+)/);
    if (redir) { try { url = decodeURIComponent(redir[1]); } catch {} }
    const title = decodeHtmlEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    const snippet = decodeHtmlEntities((sm?.[1] || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (/^https?:\/\//i.test(url) && title) results.push({ title, snippet, url });
  }
  return results.slice(0, 4);
}
async function handleOnlineContentCommand(session, jid, command, argsText, msg) {
  if (!claimCommand(msg, session)) return true;
  if (command === "$بحث_آية") {
    if (!/^\d+$/.test(String(argsText || "").trim())) {
      await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n📖 استخدم: $بحث_آية رقم_الآية\nمثال: $بحث_آية 255\nالمدى: 1 إلى 6236.`, "🌿");
      return true;
    }
    try {
      const item = await fetchQuranAyah(argsText.trim());
      await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n📖 *آية من مصدر إلكتروني*\n\n﴿${item.text}﴾\n\n📚 ${item.source}\n🔗 ${item.url}`, "🌿");
    } catch {
      await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n⚠️ تعذّر الاتصال بمصدر القرآن الآن. جرّب لاحقًا.`, "🌿");
    }
    return true;
  }
  const isHadith = command === "$بحث_حديث";
  const query = String(argsText || "").trim();
  if (!query) {
    await sendCommandText(session.sock, jid, `${BOT_NAME}\n\nاكتب كلمات البحث. مثال: ${command} فضل الصدق`, "🌐");
    return true;
  }
  try {
    const results = await searchWeb(query, isHadith ? "dorar.net" : "aldiwan.net");
    if (!results.length) {
      await sendCommandText(session.sock, jid, `${BOT_NAME}\n\nلم تظهر نتائج واضحة؛ جرّب كلمات أخرى أو أعد المحاولة لاحقًا.`, "🌐");
      return true;
    }
    const heading = isHadith ? "🔎 *بحث عن حديث — تحقّق من الحكم والتخريج*" : "🪶 *بحث عن شعر — تحقّق من نسبة النص للشاعر*";
    const body = results.map((r, i) => `${i + 1}. *${r.title}*\n${r.snippet || "افتح الرابط للتفاصيل."}\n🔗 ${r.url}`).join("\n\n");
    await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n${heading}\n\n${body}\n\n_النتائج مقتطفات بحث؛ اعتمد على المصدر الأصلي للتحقق._`, "🌐");
  } catch {
    await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n⚠️ البحث الإلكتروني غير متاح الآن؛ تأكد أن الاستضافة تسمح باتصالات HTTPS الخارجية.`, "🌐");
  }
  return true;
}
function handlePoetryCommand(session, jid, command, msg) {
  if (!claimCommand(msg, session)) return true;
  const key = command === "$شعر_عراقي" ? "iraqi" : command === "$شعر_فصيح" ? "fusha" : command === "$شعر_نبطي" ? "nabati" : "wisdom";
  const item = pickRandom(ORIGINAL_POETRY[key]);
  const labels = { iraqi: "شعر عراقي — نص أصلي", fusha: "شعر فصيح — نص أصلي", nabati: "شعر نبطي — نص أصلي", wisdom: "حكمة شعرية — نص أصلي" };
  return sendCommandText(session.sock, jid, `${BOT_NAME}\n\n🪶 *${labels[key]}*\n\n${item[0]}\n${item[1]}\n\n_أبيات أصلية للبوت وليست منسوبة لشاعر معروف._`, "🪶");
}

function pickRandom(items, minimumTextLength = 0) {
    const source = Array.isArray(items) ? items : [];

    if (source.length === 0) return null;

    if (!minimumTextLength) {
        return source[Math.floor(Math.random() * source.length)];
    }

    const longItems = source.filter(item =>
        String(item?.[0] ?? "").length >= minimumTextLength
    );

    const pool = longItems.length > 0 ? longItems : source;
    return pool[Math.floor(Math.random() * pool.length)];
}

async function sendReligiousCard(session, jid, text, accent = "🌿") {
    return sendCommandText(
        session.sock,
        jid,
        text,
        accent
    );
}

async function handleReligiousCommand(session, jid, command, msg) {
    if (!claimCommand(msg, session)) return true;

    if (command === "$دعاء") {
        const [text, source] = pickRandom(RELIGIOUS_DUAS, 70);
        await sendReligiousCard(
            session,
            jid,
            `${BOT_NAME}\n\n🤲 دعاء مأثور\n\n${text}\n\n📚 المصدر: ${source}`
        );
        return true;
    }

    if (command === "$اية") {
        const [text, source] = pickRandom(QURAN_AYAT, 80);
        await sendReligiousCard(
            session,
            jid,
            `${BOT_NAME}\n\n📖 آية قرآنية\n\n﴿${text}﴾\n\n📚 ${source}`
        );
        return true;
    }

    if (command === "$حديث") {
        const [text, source] = pickRandom(SAHIH_HADITH, 70);
        await sendReligiousCard(
            session,
            jid,
            `${BOT_NAME}\n\n📜 حديث نبوي\n\n«${text}»\n\n📚 التخريج: ${source}`
        );
        return true;
    }

    if (command === "$ذكر") {
        const [text, virtue, source] = pickRandom(MORNING_EVENING_DHIKR, 70);
        await sendReligiousCard(
            session,
            jid,
            `${BOT_NAME}\n\n📿 ذكر\n\n${text}\n\n✨ الفضل/الوقت: ${virtue}\n📚 المصدر: ${source}`
        );
        return true;
    }

    return false;
}

// ==============================
// ⏰ RELIGIOUS DAILY SCHEDULER
// ==============================

const RELIGIOUS_SCHEDULE_FILE = "./religious_schedule.json";
const RELIGIOUS_SCHEDULER_INTERVAL_MS = 15000;
const RELIGIOUS_LATE_WINDOW_MINUTES = 10;
let religiousSchedules = {};
let religiousSchedulerTimer = null;

function loadReligiousSchedules() {
    try {
        if (!fs.existsSync(RELIGIOUS_SCHEDULE_FILE)) {
            religiousSchedules = {};
            return;
        }

        religiousSchedules =
            JSON.parse(
                fs.readFileSync(RELIGIOUS_SCHEDULE_FILE, "utf8")
            ) || {};
    } catch (error) {
        religiousSchedules = {};
        console.error(
            "[RELIGIOUS] Failed loading schedules:",
            error?.message || error
        );
    }
}

function saveReligiousSchedules() {
    try {
        fs.writeFileSync(
            RELIGIOUS_SCHEDULE_FILE,
            JSON.stringify(religiousSchedules, null, 2),
            "utf8"
        );
        return true;
    } catch (error) {
        console.error(
            "[RELIGIOUS] Failed saving schedules:",
            error?.message || error
        );
        return false;
    }
}

function parseScheduleMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;

    const hour = Number(match[1]);
    const minute = Number(match[2]);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }

    return hour * 60 + minute;
}

function pickReligiousPost() {
    const choices = [
        ["دعاء", RELIGIOUS_DUAS],
        ["آية", QURAN_AYAT],
        ["حديث", SAHIH_HADITH],
        ["ذكر", MORNING_EVENING_DHIKR]
    ];

    const [kind, list] = pickRandom(choices);
    const item = pickRandom(list, kind === "آية" ? 80 : 70);

    if (kind === "دعاء") {
        return {
            accent: "🤲",
            text: `${BOT_NAME}\n\n🤲 *دعاء اليوم*\n\n${item[0]}\n\n📚 المصدر: ${item[1]}`
        };
    }

    if (kind === "آية") {
        return {
            accent: "📖",
            text: `${BOT_NAME}\n\n📖 *آية اليوم*\n\n﴿${item[0]}﴾\n\n📚 ${item[1]}`
        };
    }

    if (kind === "حديث") {
        return {
            accent: "📜",
            text: `${BOT_NAME}\n\n📜 *حديث اليوم*\n\n«${item[0]}»\n\n📚 التخريج: ${item[1]}`
        };
    }

    return {
        accent: "📿",
        text: `${BOT_NAME}\n\n📿 *ذكر اليوم*\n\n${item[0]}\n\n✨ الفضل/الوقت: ${item[1]}\n📚 المصدر: ${item[2]}`
    };
}

async function runReligiousScheduler() {
    const parts = getIraqDateParts();
    const dateKey = formatDateKey(parts.year, parts.month, parts.day);
    const currentMinutes = parts.hour * 60 + parts.minute;

    for (const [jid, schedule] of Object.entries(religiousSchedules)) {
        if (!schedule?.enabled || !schedule.time) continue;
        if (!isGroupInstalled(jid)) continue;
        if (schedule.lastPostedDate === dateKey) continue;

        const targetMinutes = parseScheduleMinutes(schedule.time);
        if (targetMinutes === null) continue;

        const difference = currentMinutes - targetMinutes;
        if (difference < 0 || difference > RELIGIOUS_LATE_WINDOW_MINUTES) {
            continue;
        }

        const sessions = getAllSessions().filter(
            item => item?.connected && item?.sock
        );

        if (!sessions.length) continue;

        const post = pickReligiousPost();
        let sent = false;

        for (const session of sessions) {
            sent = await sendReligiousCard(
                session,
                jid,
                post.text,
                post.accent
            );

            if (sent) break;
        }

        if (!sent) continue;

        schedule.lastPostedDate = dateKey;
        schedule.lastPostedAt = Date.now();
        religiousSchedules[jid] = schedule;
        saveReligiousSchedules();

        console.log(
            `[RELIGIOUS] Daily post sent | jid=${jid} | time=${schedule.time} | date=${dateKey}`
        );
    }
}

function startReligiousScheduler() {
    if (religiousSchedulerTimer) return;

    loadReligiousSchedules();

    religiousSchedulerTimer = setInterval(() => {
        runReligiousScheduler().catch(error => {
            console.error(
                "[RELIGIOUS] Scheduler error:",
                error?.stack || error?.message || error
            );
        });
    }, RELIGIOUS_SCHEDULER_INTERVAL_MS);
}

// ==============================
// 💬 MESSAGE HANDLER
// ==============================

async function handleMessage(session, msg) {
    try {
        if (!session?.sock || !msg?.message) return;

        const jid = msg.key?.remoteJid;
        if (!jid || !jid.endsWith("@g.us")) return;

        const sender = getSenderJid(msg, session);
        if (!sender) return;

        const senderNumber = getSenderNumber(msg, session);
        const messageContent = msg.message;

        // =====================================================
        // ⚡ CONTACT PROTECTION — HIGHEST MESSAGE PRIORITY
        // =====================================================
        // نلتقط Contact قبل parsing الأوامر أو أي عمل إضافي، ثم يبدأ
        // الطرد والقفل وطابور الحذف فورًا وبالتوازي.
        const contactCount = getContactCount(messageContent);

        if (isGroupInstalled(jid) && contactCount > 0) {
            if (!session.protectionEnabled) {
                    console.log(`[SECURITY] Protection OFF for ${session.label}.`);

                const disabledBody = extractMessageBody(messageContent);
                logIncomingMessage({
                    id: nextConsoleMessageId(),
                    session,
                    msg,
                    jid,
                    senderNumber,
                    body: disabledBody,
                    command: "",
                    messageContent
                });
                return;
            }

            const result = registerContactMessage(
                session.contactTracker,
                sender,
                msg.key,
                contactCount
            );

            const securityKey = getSecurityKey(jid, sender);
            const existingCase = securityProcessing.get(securityKey);

            const recordsToProcess = (result.records || [])
                .filter(record => securityRecordIdentity(record));

            if (existingCase && existingCase.status === "PROCESSING") {
                // The active case owns the queue; append each distinct message key.
                appendSecurityRecords(jid, sender, recordsToProcess);
            } else {
                // IMPORTANT: deletion is unconditional while protection is enabled.
                // The cooldown suppresses repeated kick/lock actions, not message deletion.
                void activateProtection(
                    session,
                    jid,
                    sender,
                    recordsToProcess,
                    { performActions: Boolean(result.triggered) }
                ).catch(error => {
                    console.error(
                        "[SECURITY] Protection handler failed:",
                        error?.stack || error?.message || error
                    );
                });
            }


            const contactBody = extractMessageBody(messageContent);
            logIncomingMessage({
                id: nextConsoleMessageId(),
                session,
                msg,
                jid,
                senderNumber,
                body: contactBody,
                command: "",
                messageContent
            });

            return;
        }

        const body = extractMessageBody(messageContent);
        const trimmed = body.trim();
        const parsed = parseCommand(trimmed);
        const command = parsed.command;
        const argsText = parsed.argsText;

        logIncomingMessage({
            id: nextConsoleMessageId(),
            session,
            msg,
            jid,
            senderNumber,
            body,
            command,
            messageContent
        });

        // =====================================================
        // 🎖️ INSTALL / UNINSTALL
        // =====================================================

        if (command === "$تنصيب" || command === "$الغاء_تنصيب") {
            return await handleInstallCommand(
                session,
                jid,
                senderNumber,
                command,
                msg
            );
        }

        // =====================================================
        // 📡 INSTALLATION IS THE BASIS
        // أوامر التشغيل والمحتوى تعمل فقط بعد التنصيب.
        // =====================================================

        if (!isGroupInstalled(jid)) {
            if (command === "$الاوامر" || command === "$اوامر") {
                if (!claimCommand(msg, session)) return;
                await sendFeaturedCommand(session.sock, jid, COMMANDS_MESSAGE, "✦");
            }
            return;
        }

        // =====================================================
        // 📜 PUBLIC COMMANDS
        // =====================================================

        if (command === "$الاوامر" || command === "$اوامر") {
            if (!claimCommand(msg, session)) return;
            await sendFeaturedCommand(session.sock, jid, COMMANDS_MESSAGE, "✦");
            return;
        }

        if (command === "$فحص") {
            if (!claimCommand(msg, session)) return;
            await sendFeaturedCommand(session.sock, jid, buildStatusMessage(), "●");
            return;
        }

        if (command === "$تعريف") {
            if (!claimCommand(msg, session)) return;
            await sendFeaturedCommand(session.sock, jid, buildDefinitionMessage(), "✦");
            return;
        }

        // =====================================================
        // 🔤 KEYWORDS
        // =====================================================

        if (command === "$كلمة" || command === "$كلمه") {
            const separatorIndex = argsText.indexOf("|");
            if (separatorIndex === -1) {
                await sendCommandText(session.sock, jid,
                    `${BOT_NAME}\n\n❌ *الصيغة ناقصة*\n\nاستخدم:\n\`$كلمة الكلمة|الرد\`\n\nمثال:\n\`$كلمة هلا|هلا وغلا يا وردة 🌷\``, "💗");
                return;
            }
            const trigger = argsText.slice(0, separatorIndex).trim();
            const reply = argsText.slice(separatorIndex + 1).trim();
            const normalizedTrigger = normalizeKeyword(trigger);
            if (!normalizedTrigger || !reply) {
                await sendCommandText(session.sock, jid,
                    `${BOT_NAME}\n\n⚠️ *لازم الكلمة والرد يكونن موجودات.*`, "🧡");
                return;
            }
            const groupMap = getGroupKeywordMap(jid, true);
            const previous = groupMap[normalizedTrigger];
            groupMap[normalizedTrigger] = { trigger, reply, updatedAt: new Date().toISOString() };
            if (!saveKeywordReplies()) {
                if (previous === undefined) delete groupMap[normalizedTrigger];
                else groupMap[normalizedTrigger] = previous;
                saveKeywordReplies();
                await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n❌ *ما قدرت أحفظ الكلمة.*`, "❤️");
                return;
            }
            await sendCommandText(session.sock, jid,
                `${BOT_NAME}\n\n${previous ? "🪄 *تم تعديل الكلمة*" : "🌷 *تمت إضافة الكلمة*"}\n\n🔤 *الكلمة:* ${trigger}\n💬 *الرد:* ${reply}\n\n> _الكلمة تخص هذا القروب فقط._ 🐾`, "💗");
            return;
        }

        if (command === "$الكلمات") {
            const entries = listKeywordReplies(jid);
            if (!entries.length) {
                await sendCommandText(session.sock, jid,
                    `${BOT_NAME}\n\n📭 *ماكو كلمات محفوظة بعد.*\n\nابدأ ب:\n\`$كلمة الكلمة|الرد\``, "🌷");
                return;
            }
            const lines = entries.map((e, i) => `${i + 1}. 🔤 *${e.trigger}*\n   ╰─ _${e.reply}_`);
            await sendCommandText(session.sock, jid,
                `${BOT_NAME}\n\n📚 *كلمات هذا القروب:* ${entries.length}\n\n${lines.join("\\n\\n")}\n\n> للحذف: \`$حذف_كلمة الكلمة\``, "💜");
            return;
        }

        if (command === "$حذف_كلمة" || command === "$حذف_كلمه") {
            const trigger = argsText.trim();
            const normalized = normalizeKeyword(trigger);
            const map = getGroupKeywordMap(jid, false);
            if (!normalized || !map?.[normalized]) {
                await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n🔎 *الكلمة مو موجودة بهذا القروب.*`, "🧡");
                return;
            }
            const old = map[normalized];
            delete map[normalized];
            if (!Object.keys(map).length) delete keywordReplies[jid];
            if (!saveKeywordReplies()) {
                if (!keywordReplies[jid]) keywordReplies[jid] = {};
                keywordReplies[jid][normalized] = old;
                await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n❌ *فشل حذف الكلمة من التخزين.*`, "❤️");
                return;
            }
            await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n🗑️ *تم حذف الكلمة*\n\n🔤 ${old.trigger || trigger}`, "🧡");
            return;
        }

        if (command === "$مسح_الكلمات") {
            const count = listKeywordReplies(jid).length;
            const previous = keywordReplies[jid];
            delete keywordReplies[jid];
            if (!saveKeywordReplies()) {
                if (previous) keywordReplies[jid] = previous;
                await sendCommandText(session.sock, jid, `${BOT_NAME}\n\n❌ *فشل مسح الكلمات.*`, "❤️");
                return;
            }
            await sendCommandText(session.sock, jid,
                `${BOT_NAME}\n\n🧹 *تم تنظيف كلمات القروب*\n\n📚 العدد: *${count}*\n🤍 _تم ترتيب القروب._`, "🌈");
            return;
        }

        // =====================================================
        // 📿 RELIGIOUS CONTENT — مستقل عن الألعاب
        // =====================================================
        if (["$شعر", "$شعر_عراقي", "$شعر_فصيح", "$شعر_نبطي"].includes(command)) {
            return await handlePoetryCommand(session, jid, command, msg);
        }
        if (["$بحث_آية", "$بحث_حديث", "$بحث_شعر"].includes(command)) {
            return await handleOnlineContentCommand(session, jid, command, argsText, msg);
        }

        if (
            command === "$دعاء" ||
            command === "$اية" ||
            command === "$حديث" ||
            command === "$ذكر"
        ) {
            return await handleReligiousCommand(
                session,
                jid,
                command,
                msg
            );
        }

        // =====================================================
        // 🔐 ADMIN COMMANDS
        // =====================================================

        if (ADMIN_COMMANDS.has(command)) {
            if (!(await isAuthorizedModerator(session, jid, senderNumber))) {
                if (claimCommand(msg, session)) {
                    await sendAdminOnlyMessage(session, jid);
                }
                return;
            }

            if (!claimCommand(msg, session)) return;
        }

        // =====================================================
        // ⏰ النشر الديني اليومي
        // =====================================================

        if (command === "$تعيين_النشر") {
            const match = String(argsText || "").trim().match(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);

            if (!match) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}\n\n⏰ *وقت غير صحيح*\n\nاستخدم الصيغة:\n$تعيين_النشر 21:00\n\n🇮🇶 الوقت يعتمد على توقيت العراق (UTC+3).`,
                    "⏰"
                );
                return;
            }

            const time = match[0].padStart(5, "0");
            const existing = religiousSchedules[jid] || {};
            religiousSchedules[jid] = {
                time,
                enabled: true,
                lastPostedDate: existing.lastPostedDate || null,
                updatedAt: Date.now()
            };
            saveReligiousSchedules();

            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}\n\n⏰ *تم ضبط النشر الديني*\n\n📅 يوميًا: *${time}*\n🇮🇶 التوقيت: العراق\n📿 المحتوى: دعاء / آية / حديث / ذكر\n\n💚 سيُنشر مرة واحدة يوميًا.`,
                "💚"
            );
            return;
        }

        if (command === "$وقت_النشر") {
            const schedule = religiousSchedules[jid];

            await sendCommandText(
                session.sock,
                jid,
                schedule?.enabled && schedule?.time
                    ? `${BOT_NAME}\n\n⏰ *النشر الديني مفعّل*\n\n📅 الموعد اليومي: *${schedule.time}*\n🇮🇶 توقيت العراق\n📿 الحالة: 🟢 مستمر`
                    : `${BOT_NAME}\n\n⏰ *النشر الديني متوقف*\n\nلتفعيله:\n$تعيين_النشر 21:00`,
                "⏰"
            );
            return;
        }

        if (command === "$ايقاف_النشر") {
            if (religiousSchedules[jid]) {
                religiousSchedules[jid].enabled = false;
                religiousSchedules[jid].updatedAt = Date.now();
                saveReligiousSchedules();
            }

            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}\n\n⏸️ *تم إيقاف النشر الديني التلقائي*\n\nيمكن إعادته بأي وقت عبر:\n$تعيين_النشر 21:00`,
                "🧡"
            );
            return;
        }

        // =====================================================
        // 🟢 $تشغيل
        // =====================================================

        if (command === "$تشغيل") {
            const ownerSession = getModeratorSession(senderNumber) || session;
            if (!ownerSession) return;

            ownerSession.protectionEnabled = true;
            ownerSession.contactTracker.clear();

            if (ownerSession.number && sessionsConfig[ownerSession.number]) {
                sessionsConfig[ownerSession.number].protectionEnabled = true;
                saveSessionsConfig();
            }

            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}


🟢 تم تشغيل الحماية

🏷️ الوحدة: ${ownerSession.label}
🛡️ الحالة: مفعلة
⚡ أول جهة اتصال = استجابة أمنية فورية

🎖️ المهمة مستمرة.`
            );
            return;
        }

        // =====================================================
        // 🔴 $ايقاف
        // =====================================================

        if (command === "$ايقاف") {
            const ownerSession = getModeratorSession(senderNumber) || session;
            if (!ownerSession) return;

            ownerSession.protectionEnabled = false;
            ownerSession.contactTracker.clear();

            if (ownerSession.number && sessionsConfig[ownerSession.number]) {
                sessionsConfig[ownerSession.number].protectionEnabled = false;
                saveSessionsConfig();
            }

            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}


🔴 تم إيقاف الحماية

🏷️ الوحدة: ${ownerSession.label}
🛡️ الحالة: متوقفة
📡 الاتصال بالنظام مستمر.

🎖️ يمكن إعادة التفعيل بالأمر:
$تشغيل`
            );
            return;
        }

        // =====================================================
        // 📲 $اضافة
        // =====================================================

        if (command === "$اضافة") {
            const fullArgs = argsText;
            const separatorIndex = fullArgs.indexOf("|");

            if (separatorIndex === -1) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


❌ الصيغة غير صحيحة.

الاستخدام:
$اضافة اللقب|الرقم

مثال:
$اضافة ساسكي|9647XXXXXXXXX`
                );
                return;
            }

            const label = fullArgs.slice(0, separatorIndex).trim();
            const cleanNumber = normalizeNumber(fullArgs.slice(separatorIndex + 1).trim());

            if (!label) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


❌ يجب كتابة لقب الوحدة.

مثال:
$اضافة ساسكي|9647XXXXXXXXX`
                );
                return;
            }

            if (cleanNumber.length < 10) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


❌ الرقم غير صحيح.

مثال:
$اضافة ساسكي|9647XXXXXXXXX`
                );
                return;
            }

            if (normalizeNumber(mainSession.number) === cleanNumber) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


⚠️ هذا الرقم هو الوحدة الرئيسية بالفعل.

🏷️ Arthur
📱 ${cleanNumber}`
                );
                return;
            }

            if (linkedSessions.has(cleanNumber)) {
                const existing = linkedSessions.get(cleanNumber);
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


⚠️ هذه الوحدة مرتبطة بالفعل.

🏷️ اللقب: ${existing.label}
📱 الرقم: ${cleanNumber}`
                );
                return;
            }

            if (pendingSessions.has(cleanNumber)) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


⏳ يوجد طلب اقتران لهذا الرقم بالفعل.

📱 الرقم: ${cleanNumber}
🎖️ انتظر اكتمال الاقتران.`
                );
                return;
            }

            await sendCommandText(
                session.sock,
                jid,
                `${BOT_NAME}


🟢 تم استقبال أمر إضافة وحدة.

🏷️ اللقب: ${label}
📱 الرقم: ${cleanNumber}

⏳ جاري إنشاء الجلسة...
🔐 جاري إنشاء كود الاقتران...

🎖️ لا تُسجّل الوحدة رسميًا إلا بعد نجاح الاقتران.`
            );

            await startLinkedAccount(
                cleanNumber,
                label,
                session.sock,
                jid,
                true
            );

            return;
        }

        // =====================================================
        // 🗑️ $حذف
        // =====================================================

        if (command === "$حذف") {
            if (!argsText) {
                await sendCommandText(
                    session.sock,
                    jid,
                    `${BOT_NAME}


❌ يجب كتابة لقب الوحدة.

الاستخدام:
$حذف اللقب

مثال:
$حذف ساسكي`
                );
                return;
            }

            await deleteLinkedAccount(
                argsText,
                session,
                jid
            );
            return;
        }

        // =====================================================
        // 🤖 AUTO KEYWORD REPLY
        // =====================================================
        if (!msg.key?.fromMe && body && !trimmed.startsWith("$")) {
            const keyword = findKeywordReply(jid, body);
            if (keyword) {
                await sendText(session.sock, jid, keyword.reply);
                return;
            }
        }

    } catch (error) {
        logMessageHandlerError(`[MESSAGE ERROR][${session?.label || "unknown"}]`, error, session);
    }
}

// ==============================
// 🌐 HTTP HEALTH / PROCESS GUARDS
// ==============================

let healthServer = null;
let shutdownInProgress = false;
let healthServerStarted = false;
let healthSelfPingTimer = null;
let healthCheckTimer = null;

function startHealthServer() {
    if (healthServerStarted || healthServer) return;

    healthServer = http.createServer((req, res) => {
        const url = String(req.url || "").split("?")[0];

        if (url === "/" || url === "/health") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
                status: "online",
                bot: BOT_TITLE,
                uptime: Math.floor(process.uptime()),
                timestamp: new Date().toISOString()
            }));
            return;
        }

        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
    });

    healthServer.on("error", error => {
        healthServerStarted = false;
        writeWatchdogLog("[HEALTH] HTTP server error", error);
    });

    healthServer.listen(HEALTH_PORT, HEALTH_HOST, () => {
        healthServerStarted = true;
        console.log(
            `[HEALTH] HTTP server listening on ${HEALTH_HOST}:${HEALTH_PORT}`
        );
    });
}

function pingHealthEndpoint() {
    try {
        const target = new URL(HEALTH_SELF_PING_URL);
        const client = target.protocol === "https:" ? https : http;

        const request = client.get(target, response => {
            response.resume();
            response.on("error", error => {
                writeWatchdogLog("[HEALTH] Self-ping response error", error);
            });
        });

        request.setTimeout(10000, () => {
            request.destroy(new Error("health self-ping timeout"));
        });

        request.on("error", error => {
            writeWatchdogLog("[HEALTH] Self-ping failed", error);
        });
    } catch (error) {
        writeWatchdogLog("[HEALTH] Self-ping setup failed", error);
    }
}

function startHealthSelfPing() {
    if (healthSelfPingTimer) return;

    healthSelfPingTimer = setInterval(
        pingHealthEndpoint,
        HEALTH_SELF_PING_MS
    );

    if (typeof healthSelfPingTimer.unref === "function") {
        healthSelfPingTimer.unref();
    }
}

function writeWatchdogLog(message, error = null) {
    const timestamp = new Date().toISOString();
    const details = error
        ? ` | ${error?.stack || error?.message || error}`
        : "";
    const line = `[${timestamp}] ${message}${details}\n`;

    try {
        fs.appendFileSync(
            WATCHDOG_LOG_FILE,
            line,
            "utf8"
        );
    } catch {}

    console.log(message, error ? (error?.message || error) : "");
}

function restartMainSessionFromHealth(reason) {
    if (
        shutdownInProgress ||
        mainSession.authInvalid ||
        mainSession.starting
    ) {
        return;
    }

    const oldSocket = mainSession.sock;
    mainSession.connected = false;
    mainSession.healthStaleCount = 0;
    mainSession.healthProbeFailures = 0;
    mainSession.healthProbeInFlight = false;
    mainSession.lastHealthProbeAt = 0;
    mainSession.lastHealthActivityAt = Date.now();
    mainSession.sock = null;

    writeWatchdogLog(
        `[WATCHDOG] MAIN restart requested | reason=${reason}`
    );

    try {
        oldSocket?.end();
    } catch (error) {
        writeWatchdogLog(
            "[WATCHDOG] Failed closing stale main socket",
            error
        );
    }

    scheduleMainReconnect(
        500,
        `watchdog: ${reason}`
    );
}

function restartLinkedSessionFromHealth(session) {
    if (
        shutdownInProgress ||
        !session ||
        session.deleting ||
        session.isPending ||
        session.authInvalid
    ) {
        return;
    }

    const number = normalizeNumber(session.number);
    if (!number) return;

    const current = linkedSessions.get(number);
    if (current && current !== session) return;

    linkedSessions.delete(number);
    session.connected = false;
    session.reconnectScheduled = true;
    session.healthStaleCount = 0;
    session.healthProbeFailures = 0;
    session.healthProbeInFlight = false;
    session.lastHealthProbeAt = 0;
    session.lastHealthActivityAt = Date.now();

    writeWatchdogLog(
        `[WATCHDOG] ${session.label}: linked socket rebuild requested`
    );

    try {
        session.sock?.end();
    } catch (error) {
        writeWatchdogLog(
            `[WATCHDOG] ${session.label}: failed closing stale linked socket`,
            error
        );
    }

    scheduleLinkedAccountReconnect(
        number,
        session.label,
        500,
        'watchdog socket rebuild',
        Number(linkedReconnectAttempts.get(number) || 0)
    );
}

function getWebSocketState(session) {
    const readyState = session?.sock?.ws?.readyState;

    if (typeof readyState !== "number") {
        return {
            known: false,
            state: "unknown"
        };
    }

    const names = [
        "CONNECTING",
        "OPEN",
        "CLOSING",
        "CLOSED"
    ];

    return {
        known: true,
        state: names[readyState] || String(readyState),
        readyState
    };
}

async function probeSessionNetwork(session) {
    if (
        !session?.sock ||
        !session.connected ||
        session.healthProbeInFlight
    ) {
        return null;
    }

    session.healthProbeInFlight = true;
    session.lastHealthProbeAt = Date.now();

    try {
        if (typeof session.sock.sendPresenceUpdate !== "function") {
            throw new Error("sendPresenceUpdate is unavailable");
        }

        // هذا طلب حقيقي عبر Socket، وليس مجرد فحص متغير محلي.
        // إذا بقيت اللوحة تقول ONLINE بينما واتساب ميت، هذا الاختبار يفشل.
        await Promise.race([
            session.sock.sendPresenceUpdate("available"),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("network probe timeout")), HEALTH_PROBE_TIMEOUT_MS)
            )
        ]);

        session.healthProbeFailures = 0;
        session.healthStaleCount = 0;
        return true;
    } catch (error) {
        session.healthProbeFailures =
            Number(session.healthProbeFailures || 0) + 1;

        writeWatchdogLog(
            `[HEALTH] ${session.label}: network probe failed | failures=${session.healthProbeFailures}`,
            error
        );

        return false;
    } finally {
        session.healthProbeInFlight = false;
    }
}

async function runHealthSocketCheck() {
    for (const session of getAllSessions()) {
        if (!session?.sock || !session.connected) {
            continue;
        }

        const state = getWebSocketState(session);
        const socketAgeMs = Date.now() - Number(session.socketStartedAt || Date.now());

        // In this Baileys build the raw WebSocket state can be unavailable.
        // If it stays unavailable for a long-lived socket, rotate the existing
        // authenticated connection every 12 hours instead of trusting a probe
        // that only proves an outbound packet was accepted. This never requests
        // a new pairing code and never deletes auth/session files.
        if (!state.known && socketAgeMs >= SOCKET_MAX_AGE_MS) {
            writeWatchdogLog(`[WATCHDOG] ${session.label}: WebSocket state unavailable after ${Math.floor(socketAgeMs / 3600000)}h; scheduled authenticated socket renewal.`);
            if (session === mainSession) {
                restartMainSessionFromHealth("12h maintenance renewal; websocket state unavailable");
            } else {
                restartLinkedSessionFromHealth(session);
            }
            continue;
        }

        if (state.known && state.readyState !== 1) {
            writeWatchdogLog(
                `[WATCHDOG] ${session.label}: connected=true but WebSocket=${state.state}. Restarting.`
            );

            if (session === mainSession) {
                restartMainSessionFromHealth(`websocket state ${state.state}`);
            } else {
                restartLinkedSessionFromHealth(session);
            }
            continue;
        }

        const probe = await probeSessionNetwork(session);

        if (probe === true) {
            writeWatchdogLog(
                `[HEALTH] ${session.label}: outbound probe OK (does not verify inbound messages) | ws=${state.known ? state.state : "unavailable"}`
            );
            continue;
        }

        if (probe === false) {
            const failures = Number(session.healthProbeFailures || 0);

            if (failures < HEALTH_STALE_THRESHOLD) {
                writeWatchdogLog(
                    `[HEALTH] ${session.label}: probe failure ${failures}/${HEALTH_STALE_THRESHOLD}; keeping socket for now.`
                );
                continue;
            }

            writeWatchdogLog(
                `[WATCHDOG] ${session.label}: ${HEALTH_STALE_THRESHOLD} consecutive network probes failed. Rebuilding socket.`
            );

            if (session === mainSession) {
                restartMainSessionFromHealth(
                    "network probe failed repeatedly"
                );
            } else {
                restartLinkedSessionFromHealth(session);
            }
        }
    }
}

function startHealthSocketCheck() {
    if (healthCheckTimer) return;

    healthCheckTimer = setInterval(
        runHealthSocketCheck,
        HEALTH_CHECK_MS
    );
}

async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;

    shutdownInProgress = true;
    console.log(`[PROCESS] ${signal} received. Saving data and shutting down...`);

    try {
        saveSessionsConfig();
    } catch {}

    try {
        saveInstalledGroups();
    } catch {}

    try {
        saveReligiousSchedules();
    } catch {}

    if (healthSelfPingTimer) {
        clearInterval(healthSelfPingTimer);
        healthSelfPingTimer = null;
    }

    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }

    if (healthServer) {
        await new Promise(resolve => {
            try {
                healthServer.close(() => resolve());
            } catch {
                resolve();
            }
        });
    }

    const closeTasks = [];

    for (const session of getAllSessions()) {
        try {
            session.connected = false;
            if (session.sock) {
                session.sock.end();
            }
        } catch {}
    }

    await Promise.allSettled(closeTasks);

    process.exit(0);
}

process.on("uncaughtException", error => {
    writeWatchdogLog(
        "[PROCESS] uncaughtException",
        error
    );
});

process.on("unhandledRejection", reason => {
    writeWatchdogLog(
        "[PROCESS] unhandledRejection",
        reason
    );
});

process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
});

// ==============================
// 🔄 MAIN CONNECTION HELPERS
// ==============================

function getDisconnectStatusCode(lastDisconnect) {
    return (
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.statusCode ??
        null
    );
}

function scheduleMainReconnect(delayMs, reason = "transient disconnect") {
    if (mainSession.reconnectTimer) return;

    const attempt = Number(mainSession.reconnectAttempts || 0);
    const backoffMs = Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(attempt, 6)));
    const requestedDelay = Math.max(Number(delayMs) || 0, backoffMs);
    const jitterMs = Math.floor(Math.random() * 1200);
    const actualDelay = requestedDelay + jitterMs;
    mainSession.reconnectAttempts = attempt + 1;

    console.log(`[CONNECTION] Reconnect scheduled in ${actualDelay}ms | attempt=${attempt + 1} | ${reason}`);

    mainSession.reconnectTimer = setTimeout(() => {
        mainSession.reconnectTimer = null;

        startBot().catch(error => {
            console.error(
                "[CONNECTION] Reconnect start failed:",
                error?.stack || error?.message || error
            );

            scheduleMainReconnect(
                2500,
                "restart after start failure"
            );
        });
    }, actualDelay);
}

function clearMainReconnectTimer() {
    if (!mainSession.reconnectTimer) {
        return;
    }

    clearTimeout(mainSession.reconnectTimer);
    mainSession.reconnectTimer = null;
}

// ==============================
// 🤖 MAIN BOT
// ==============================

async function startBot() {
    if (mainSession.starting) {
        return;
    }

    clearMainReconnectTimer();

    mainSession.starting = true;
    mainSession.connected = false;

    const socketGeneration =
        (mainSession.socketGeneration || 0) + 1;

    mainSession.socketGeneration = socketGeneration;
    mainSession.healthStaleCount = 0;
    mainSession.healthProbeFailures = 0;
    mainSession.healthProbeInFlight = false;
    mainSession.lastHealthProbeAt = 0;

    console.log(
        `[BOT] Starting ${BOT_TITLE}...`
    );

    try {
        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            AUTH_FOLDER
        );

        // =====================================================
        // 👑 MAIN OWNER LOCK
        // =====================================================

        const storedNumber =
            state.creds.me?.id
                ? normalizeNumber(
                    state.creds.me.id
                        .split(":")[0]
                        .split("@")[0]
                )
                : "";

        if (
            storedNumber &&
            storedNumber !== MAIN_OWNER_NUMBER
        ) {
            mainSession.authInvalid = true;

            console.warn(
                `[AUTH] Stored main session belongs to ${storedNumber}. Expected ${MAIN_OWNER_NUMBER}. No automatic deletion or pairing.`
            );

            return;
        }

        mainSession.number = MAIN_OWNER_NUMBER;
        mainSession.authInvalid = false;

        const sock = makeWASocket({
            auth: state,
            keepAliveIntervalMs: 30000,
            // WhatsApp Web rotates protocol versions; pin the current
            // upstream version to avoid 405 handshake rejection.
            version: [2, 3000, 1043857760],
            logger: pino({
                level: "silent"
            }),
            printQRInTerminal: false
        });

        mainSession.sock = sock;
        mainSession.socketStartedAt = Date.now();

        sock.ev.on(
            "creds.update",
            () => {
                mainCredsSavePromise = mainCredsSavePromise
                    .catch(() => undefined)
                    .then(() => saveCreds())
                    .catch(error => {
                        console.error(
                            "[AUTH] Failed saving credentials:",
                            error?.message || error
                        );
                    });
            }
        );

        // =====================================================
        // 🔌 MAIN CONNECTION
        // =====================================================

        sock.ev.on(
            "connection.update",
            async update => {
                if (
                    mainSession.sock !== sock ||
                    mainSession.socketGeneration !== socketGeneration
                ) {
                    return;
                }

                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                // ======================
                // 🟢 OPEN
                // ======================

                if (connection === "open") {
                    mainSession.connected = true;
                    mainSession.reconnectAttempts = 0;
                    mainSession.number = MAIN_OWNER_NUMBER;
                    mainSession.authInvalid = false;
                    mainSession.healthStaleCount = 0;
                    mainSession.healthProbeFailures = 0;
                    mainSession.lastHealthActivityAt = Date.now();

                    console.log("");
                    console.log("========================================");
                    console.log(`${BOT_TITLE}`);
                    console.log(`👑 المالك: ${OWNER_DISPLAY_NAME}`);
                    console.log("🟢 الوحدة الرئيسية متصلة بواتساب.");
                    console.log("🛡️ نظام الحماية: فعال");
                    console.log("⚔️ أول جهة اتصال: استجابة فورية");
                    console.log("📡 نظام التنصيب: فعال");
                    console.log("📥 قارئ الرسائل: مُفعّل");
                    console.log("📤 مراقبة ردود البوت: مُفعّلة");
                    console.log("========================================");
                    console.log("");

                    return;
                }

                if (connection !== "close") {
                    return;
                }

                mainSession.connected = false;

                const statusCode =
                    getDisconnectStatusCode(
                        lastDisconnect
                    );

                const disconnectError =
                    lastDisconnect?.error;

                console.log(
                    `\n[CONNECTION] ⚠️ الاتصال انغلق | code=${statusCode ?? "unknown"}`
                );
                console.log(
                    `[CONNECTION] السبب: ${disconnectError?.message || "غير محدد"}`
                );

                // =================================================
                // 🚪 401 = لا إعادة اقتران تلقائي ولا حذف للجلسة
                // =================================================

                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {
                    mainSession.authInvalid = true;

                    console.log(
                        "[CONNECTION] 🔐 الجلسة الرئيسية رجعت 401. لن يتم حذف الجلسة أو طلب كود جديد تلقائيًا."
                    );

                    try {
                        sock.end();
                    } catch {}

                    if (
                        mainSession.sock === sock &&
                        mainSession.socketGeneration === socketGeneration
                    ) {
                        mainSession.sock = null;
                    }

                    return;
                }

                // Pairing was never completed on this socket. Do not create
                // another socket automatically, otherwise 428/515 can turn
                // into an endless pairing-code loop.
                if (!state.creds.registered && !state.creds.me?.id) {
                    console.log(
                        `[PAIRING] Main pairing socket closed before registration. Automatic re-pairing disabled. code=${statusCode ?? "unknown"}`
                    );

                    try {
                        sock.end();
                    } catch {}

                    if (
                        mainSession.sock === sock &&
                        mainSession.socketGeneration === socketGeneration
                    ) {
                        mainSession.sock = null;
                    }

                    return;
                }

                // Wait for the latest creds.update writes before reopening on 515.
                if (
                    statusCode ===
                    DisconnectReason.restartRequired
                ) {
                    console.log(
                        "[CONNECTION] 🔄 515 Restart Required — انتظار حفظ الاعتماد ثم إعادة فتح Socket."
                    );

                    await mainCredsSavePromise.catch(() => undefined);

                    try {
                        sock.end();
                    } catch {}

                    if (
                        mainSession.sock === sock &&
                        mainSession.socketGeneration === socketGeneration
                    ) {
                        mainSession.sock = null;
                    }

                    scheduleMainReconnect(
                        350,
                        "restart required (515)"
                    );

                    return;
                }

                // =================================================
                // ⏱️ 408 = Connection Timeout
                // =================================================

                if (statusCode === 408) {
                    console.log(
                        `[CONNECTION] ⏱️ 408 Connection Timeout | registered=${state.creds.registered ? "yes" : "no"}`
                    );

                    try {
                        sock.end();
                    } catch {}

                    if (
                        mainSession.sock === sock &&
                        mainSession.socketGeneration === socketGeneration
                    ) {
                        mainSession.sock = null;
                    }

                    scheduleMainReconnect(
                        1200,
                        "connection timeout (408)"
                    );

                    return;
                }

                // =================================================
                // 🌐 باقي الانقطاعات المؤقتة
                // =================================================

                try {
                    sock.end();
                } catch {}

                if (
                    mainSession.sock === sock &&
                    mainSession.socketGeneration === socketGeneration
                ) {
                    mainSession.sock = null;
                }

                scheduleMainReconnect(
                    1500,
                    `transient disconnect (${statusCode ?? "unknown"})`
                );
            }
        );

        // ==========================
        // 💬 MAIN MESSAGES
        // ==========================

        sock.ev.on(
            "messages.upsert",
            async ({ messages, type }) => {
                mainSession.lastHealthActivityAt = Date.now();
                mainSession.healthStaleCount = 0;
                mainSession.healthProbeFailures = 0;

                const batch = messages || [];

                console.log(
                    `[INBOX] messages.upsert | type=${type} | count=${batch.length}`
                );

                if (type !== "notify") {
                    console.log(
                        `[INBOX] تجاهل الحدث لأن نوعه ليس notify: ${type}`
                    );
                    return;
                }

                for (const msg of batch) {
                    void handleMessage(mainSession, msg).catch(error => {
                        logMessageHandlerError('[MESSAGE ERROR]', error, mainSession);
                    });
                }
            }
        );

        // ==========================
        // 🧹 CLEAN OLD PENDING
        // ==========================

        if (!transientStartupCleanupDone) {
            transientStartupCleanupDone = true;

        try {
            const pendingFolders =
                fs.readdirSync(
                    PENDING_SESSIONS_FOLDER,
                    {
                        withFileTypes: true
                    }
                );

            for (const folder of pendingFolders) {
                if (!folder.isDirectory()) {
                    continue;
                }

                const oldPendingPath = path.join(PENDING_SESSIONS_FOLDER, folder.name);
                const number = folder.name;

                // Older builds renamed the auth directory while its callbacks still
                // pointed at pending_sessions. For registered accounts, merge the
                // newest files back before cleaning that stale directory.
                if (/^\d+$/.test(number) && sessionsConfig[number]) {
                    const permanentPath = getSessionFolder(number);
                    mergeAuthStateFolder(oldPendingPath, permanentPath);
                    console.log(`[MIGRATION] Merged legacy auth-state files for ${number}.`);
                } else {
                    console.log(`[CLEANUP] Removing unregistered pending session: ${folder.name}`);
                }
                removeFolder(oldPendingPath);
            }
        } catch {}
        }

        // ==========================
        // 🔄 LOAD SAVED SESSIONS
        // ==========================

        try {
            const folders =
                fs.readdirSync(
                    SESSIONS_FOLDER,
                    {
                        withFileTypes: true
                    }
                );

            for (const folder of folders) {
                if (!folder.isDirectory()) {
                    continue;
                }

                const number = folder.name;

                if (!/^\d+$/.test(number)) {
                    continue;
                }

                if (!sessionsConfig[number]) {
                    console.log(
                        `[SESSION] Skipping unregistered session ${number}`
                    );

                    continue;
                }

                const config =
                    sessionsConfig[number];

                console.log(
                    `[SESSION] Loading ${number}...`
                );

                startLinkedAccount(
                    number,
                    config.label
                ).catch(error => {
                    console.error(`[SESSION] Failed loading ${number}:`, error?.stack || error?.message || error);
                    scheduleLinkedAccountReconnect(number, config.label, 5000, 'startup session load', 0);
                });
            }
        } catch (error) {
            console.error(
                "[SESSION] Failed loading sessions:",
                error
            );
        }

        // =====================================================
        // 📲 FIRST PAIRING
        // requestMainPairing() is triggered from
        // connection.update after connecting/QR readiness.
        // =====================================================

        if (!state.creds.registered) {
            console.log(
                `[PAIRING] Starting old working pairing flow for ${MAIN_OWNER_NUMBER}...`
            );

            requestMainPairing(sock).catch(error => {
                console.error(
                    "[PAIRING] Main pairing request failed:",
                    error?.stack || error?.message || error
                );
            });
        } else {
            console.log(
                `[AUTH] Existing main credentials loaded for ${MAIN_OWNER_NUMBER}.`
            );
        }

        // ==========================
        // 🧾 INFO
        // ==========================

        console.log("\nARTHUR | OFFICIAL");
        console.log("────────────────────────────────────────");
        console.log("🦊 Identity    : ARTHUR");
        console.log("🎖️ Bot         : ARTHUR");
        console.log(`👑 Owner       : ${MAIN_OWNER_NUMBER}`);
        console.log("🛡️ Protection  : FIRST CONTACT");
        console.log("⚔️ Priority    : KICK / LOCK / DEL");
        console.log("📡 Install     : $تنصيب");
        console.log("📡 Uninstall   : $الغاء_تنصيب");
        console.log("📲 Sessions    : MULTI ACCOUNT");
        console.log("────────────────────────────────────────\n");
    } finally {
        mainSession.starting = false;
    }
}

// ==============================
// 🚀 RUN
// ==============================

startHealthServer();
startHealthSelfPing();
startHealthSocketCheck();
startReligiousScheduler();

pingHealthEndpoint();

startBot().catch(error => {
    console.error(
        "[FATAL ERROR]",
        error
    );

    process.exit(1);
});
