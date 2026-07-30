যে// -------------------------------------------------------------
// ১. পাসওয়ার্ড ও ইউজারনেম ইনপুট নেওয়া
// -------------------------------------------------------------
let enterPassword = "";
while (!enterPassword || enterPassword.trim() === "") {
  enterPassword = prompt("🔑 PASSWORD:");
  if (enterPassword === null) {
    alert("password REQUARIED!");
  }
}

let USERNAME = "";
while (!USERNAME || USERNAME.trim() === "") {
  USERNAME = prompt("👤 Name:");
  if (USERNAME === null) {
    alert("Name Required!");
  }
}

// SHARED SECRET & CLOUDINARY CONFIG
const SHARED_SECRET_PASSWORD = enterPassword; 
const CLOUD_NAME = "bfq3wa5j";       // আপনার Cloudinary Name বসান
const UPLOAD_PRESET = "ml_defult"; // আপনার Cloudinary Preset বসান

let isHost = false;

// -------------------------------------------------------------
// ২. DOM Elements ধরা
// -------------------------------------------------------------
const statusContainer = document.getElementById('statusContainer');
const statusText = document.getElementById('statusText');
const statusSubText = document.getElementById('statusSubText');
const chatCard = document.getElementById('chatCard');

const chatWindow = document.getElementById('chatWindow');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const imageInput = document.getElementById('imageInput');
const fileInput = document.getElementById('fileInput');
const roleBadge = document.getElementById('roleBadge');

let pendingFileToUpload = null;
const MAX_DIRECT_SIZE = 10 * 1024 * 1024; 

// -------------------------------------------------------------
// ৩. WebSocket Connection Setup
// -------------------------------------------------------------
function createDemoJWT(username) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ username: username }));
  return `${header}.${payload}.demo_signature`;
}

const token = createDemoJWT(USERNAME);
const RENDER_DOMAIN = "friend-confarence.onrender.com"; // আপনার Render Domain
const serverUrl = `wss://${RENDER_DOMAIN}?pass=${encodeURIComponent(enterPassword)}&token=${token}`;

const socket = new WebSocket(serverUrl);

// -------------------------------------------------------------
// ৪. WebSocket Event Handlers (কানেকশন টেস্ট ও এরর হ্যান্ডলিং)
// -------------------------------------------------------------

// 🚀 কানেকশন সফল হলে
socket.addEventListener('open', () => {
  if (statusContainer) statusContainer.style.display = 'none';
  if (chatCard) chatCard.style.display = 'block';
});

// ❌ কানেকশন বন্ধ বা পাসওয়ার্ড ভুল হলে
socket.addEventListener('close', (e) => {
  if (chatCard) chatCard.style.display = 'none';
  if (statusContainer) statusContainer.style.display = 'block';

  if (e.code === 4003) {
    statusText.innerText = "❌ wrong password!";
    statusText.style.color = "#dc3545";
    statusSubText.innerText = "INCORRECT password.Load page and try again!";
  } else {
    statusText.innerText = "⚠️ server disconnected!";
    statusText.style.color = "#ffc107";
    statusSubText.innerText = "check internet connection।";
  }
});

// 🚨 নেটওয়ার্ক এরর
socket.addEventListener('error', (err) => {
  console.error("WebSocket Error:", err);
  if (statusText) {
    statusText.innerText = "❌ connection error!";
    statusText.style.color = "#dc3545";
  }
});

// -------------------------------------------------------------
// ৫. Encryption Logic (AES-GCM)
// -------------------------------------------------------------
let cryptoKey;
async function initCrypto() {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw", enc.encode(SHARED_SECRET_PASSWORD), "PBKDF2", false, ["deriveKey"]
  );
  cryptoKey = await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("fixed_salt"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
const cryptoInitPromise = initCrypto();

async function encryptData(text) {
  await cryptoInitPromise;
  const enc = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, cryptoKey, enc.encode(text)
  );
  return JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  });
}

async function decryptData(cipherJson) {
  await cryptoInitPromise;
  const { iv, data } = JSON.parse(cipherJson);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    cryptoKey,
    new Uint8Array(data)
  );
  return new TextDecoder().decode(decrypted);
}

// -------------------------------------------------------------
// ৬. Helper Functions & Event Listeners
// -------------------------------------------------------------
async function uploadToCloud(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, {
    method: 'POST',
    body: formData
  });
  const data = await res.json();
  return data.secure_url;
}

function appendChat(sender, htmlContent) {
  const div = document.createElement('div');
  div.style.margin = '8px 0';
  div.innerHTML = `<strong>${sender}:</strong> ${htmlContent}`;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function sendEncryptedPayload(type, rawData) {
  const rawPayload = JSON.stringify({ type, data: rawData });
  const encryptedString = await encryptData(rawPayload);
  socket.send(encryptedString);
}

sendBtn.addEventListener('click', async () => {
  const msg = messageInput.value.trim();
  if (!msg) return;
  await sendEncryptedPayload('text', msg);
  appendChat('You', msg);
  messageInput.value = '';
});

imageInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    appendChat('System', 'photo is uploading...');
    const url = await uploadToCloud(file);
    await sendEncryptedPayload('image', url);
    appendChat('You', `<img src="${url}" class="chat-img"/>`);
  }
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > MAX_DIRECT_SIZE) {
    pendingFileToUpload = file;
    alert(`ফাইল সাইজ ${(file.size / (1024 * 1024)).toFixed(1)} MB। হোস্টের অনুমতি চাওয়া হচ্ছে...`);
    
    socket.send(JSON.stringify({
      type: 'request_permission',
      fileName: file.name,
      fileSize: (file.size / (1024 * 1024)).toFixed(1) + ' MB'
    }));
    return;
  }

  appendChat('System', 'file is uploading...');
  const url = await uploadToCloud(file);
  await sendEncryptedPayload('file_link', { url: url, fileName: file.name });
  appendChat('You', `<a href="${url}" target="_blank">📁 ${file.name} (Download)</a>`);
});

// 📩 ইনকামিং মেসেজ রিসিভ করা
socket.addEventListener('message', async (event) => {
  try {
    const data = JSON.parse(event.data);

    if (data.system) {
      if (data.type === 'role_assign') {
        isHost = data.isHost;
        if (roleBadge) roleBadge.style.display = isHost ? 'inline-block' : 'none';
        if (isHost) appendChat('System', '🌟 You are Host NOW!');
      } else if (data.type === 'history') {
        for (let msgData of data.messages) {
          const dec = await decryptData(msgData.payload);
          const parsed = JSON.parse(dec);
          renderParsedMessage(msgData.sender, parsed);
        }
      }
      return;
    }

    if (data.type === 'host_approval_required' && isHost) {
      const approved = confirm(`${data.from} a ${data.fileSize} size file (${data.fileName}) wants permission.`);
      socket.send(JSON.stringify({
        type: 'permission_response',
        targetUser: data.requesterId,
        allowed: approved
      }));
      return;
    }

    if (data.type === 'permission_result') {
      if (data.allowed && pendingFileToUpload) {
        alert("gained permission...");
        const url = await uploadToCloud(pendingFileToUpload);
        await sendEncryptedPayload('file_link', { url: url, fileName: pendingFileToUpload.name });
        appendChat('You', `<a href="${url}" target="_blank">📁 ${pendingFileToUpload.name} (Download)</a>`);
        pendingFileToUpload = null;
      } else {
        alert("REJECTED!");
        pendingFileToUpload = null;
      }
      return;
    }

    const decryptedString = await decryptData(data.payload);
    const parsed = JSON.parse(decryptedString);
    renderParsedMessage(data.sender, parsed);

  } catch (err) {
    console.error(err);
  }
});

function renderParsedMessage(sender, parsed) {
  if (parsed.type === 'text') appendChat(sender, parsed.data);
  else if (parsed.type === 'image') appendChat(sender, `<img src="${parsed.data}" class="chat-img"/>`);
  else if (parsed.type === 'audio') appendChat(sender, `<audio controls src="${parsed.data}"></audio>`);
  else if (parsed.type === 'location') appendChat(sender, `<a href="${parsed.data}" target="_blank">📍 Location</a>`);
  else if (parsed.type === 'file_link') appendChat(sender, `<a href="${parsed.data.url}" target="_blank">📁 ${parsed.data.fileName} (Download)</a>`);
                                          }
