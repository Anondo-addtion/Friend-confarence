const FIXED_SERVER_URL = "wss://friend-confarence.onrender.com";
const CLOUD_NAME = "bfq3wa5j";       
const UPLOAD_PRESET = "ml_defult";  

let socket = null;
let username = "";
let password = "";
let cryptoKey = null;
let isHost = false;
let pendingFileToUpload = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let pingInterval = null;

const MAX_DIRECT_SIZE = 10 * 1024 * 1024; // 10MB

// DOM Elements
const loginModal = document.getElementById('loginModal');
const loginBtn = document.getElementById('loginBtn');
const loginBtnText = document.getElementById('loginBtnText');
const loginBtnIcon = document.getElementById('loginBtnIcon');
const loginStatusMsg = document.getElementById('loginStatusMsg');

const chatWindow = document.getElementById('chatWindow');
const messageInput = document.getElementById('messageInput');
const statusIndicator = document.getElementById('statusIndicator');
const connectionText = document.getElementById('connectionText');
const hostBadge = document.getElementById('hostBadge');

// 1. ENCRYPTION ENGINE
async function initCrypto(secretPassword) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw", enc.encode(secretPassword), "PBKDF2", false, ["deriveKey"]
  );
  cryptoKey = await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("chat_room_fixed_salt"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(text) {
  if (!cryptoKey) return null;
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
  try {
    if (!cryptoKey) return "[ডিক্রিপশন কি পাওয়া যায়নি]";
    const { iv, data } = JSON.parse(cipherJson);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      cryptoKey,
      new Uint8Array(data)
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    return "[❌ এনক্রিপশন কি মিলছে না বা মেসেজটি বিকৃত]";
  }
}

function createDemoJWT(user) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ username: user }));
  return `${header}.${payload}.demo_signature`;
}

// 2. WEBSOCKET CONNECTION
async function startConnection() {
  username = document.getElementById('usernameInput').value.trim();
  password = document.getElementById('passwordInput').value.trim();

  if (!username || !password) {
    showAlert("অনুগ্রহ করে নাম এবং পাসওয়ার্ড দিন।");
    return;
  }

  loginBtn.disabled = true;
  loginBtnText.innerText = "যাচাই করা হচ্ছে...";
  loginBtnIcon.className = "fa-solid fa-circle-notch fa-spin";
  loginStatusMsg.classList.remove('hidden');

  await initCrypto(password);

  const token = createDemoJWT(username);
  const fullUrl = `${FIXED_SERVER_URL}?pass=${encodeURIComponent(password)}&token=${encodeURIComponent(token)}`;

  connectionText.innerText = "সার্ভারে কানেক্ট করা হচ্ছে...";
  
  try {
    if (socket) {
      stopPingPong();
      socket.close();
    }
    socket = new WebSocket(fullUrl);
  } catch (err) {
    resetLoginBtn();
    showAlert("সার্ভার কানেকশন সমস্যা হয়েছে!");
    return;
  }

  socket.addEventListener('open', () => {
    startPingPong();
  });

  socket.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'pong') return;

      if (data.system) {
        if (data.type === 'role_assign') {
          resetLoginBtn();
          loginModal.classList.add('hidden'); 
          statusIndicator.className = "status-dot online";
          connectionText.innerText = "সংযুক্ত রয়েছে (Encrypted)";
          connectionText.style.color = "#34d399";

          isHost = data.isHost;
          hostBadge.classList.toggle('hidden', !isHost);
          if (isHost) appendSystemMessage("🌟 আপনি এই চ্যাটারুমের হোস্ট (Host)।");
          else appendSystemMessage("🔒 নিরাপদভাবে চ্যাটরুমে যুক্ত হয়েছেন।");
        } else if (data.type === 'history') {
          for (let msgData of data.messages) {
            const decryptedStr = await decryptData(msgData.payload);
            try {
              const parsed = JSON.parse(decryptedStr);
              renderParsedMessage(msgData.sender, parsed);
            } catch {
              renderParsedMessage(msgData.sender, { type: 'text', data: decryptedStr });
            }
          }
        } else if (data.type === 'host_approval_required' && isHost) {
          showApprovalModal(data);
        } else if (data.type === 'permission_result') {
          if (data.allowed && pendingFileToUpload) {
            appendSystemMessage("✅ ফাইল আপলোডের অনুমতি মিলেছে...");
            const url = await uploadToCloud(pendingFileToUpload);
            await sendEncryptedPayload('file_link', { url: url, fileName: pendingFileToUpload.name });
            appendChatMessage('You', { type: 'file_link', data: { url: url, fileName: pendingFileToUpload.name } }, true);
            pendingFileToUpload = null;
          } else {
            showAlert("❌ হোস্ট অনুমতি প্রত্যাখ্যান করেছে।");
            pendingFileToUpload = null;
          }
        }
        return;
      }

      const decryptedString = await decryptData(data.payload);
      try {
        const parsed = JSON.parse(decryptedString);
        renderParsedMessage(data.sender, parsed);
      } catch {
        renderParsedMessage(data.sender, { type: 'text', data: decryptedString });
      }

    } catch (err) {
      console.error("Message Error:", err);
    }
  });

  // 🔒 ভুল পাসওয়ার্ড এবং IP ব্লকিং কানেকশন হ্যান্ডলিং
  socket.addEventListener('close', (e) => {
    stopPingPong();
    resetLoginBtn();
    statusIndicator.className = "status-dot offline";
    connectionText.innerText = "ডিসকানেক্ট হয়েছে";
    connectionText.style.color = "#f87171";

    // server.js এর ৩ বার ভুল পাসওয়ার্ড চেক করার স্থানে এই কোডটি আপডেট করতে পারেন:

if (failedAttempts[clientIP] >= 3) {
  blockedIPs.add(clientIP);
  console.log(`IP Blocked: ${clientIP}`);
  ws.close(4003, 'IP_BLOCKED');

  // ⏳ ৩০ মিনিট (1800000 ms) পর নিজে থেকেই IP আনব্লক হয়ে যাবে
  setTimeout(() => {
    blockedIPs.delete(clientIP);
    failedAttempts[clientIP] = 0;
    console.log(`IP Unblocked automatically: ${clientIP}`);
  }, 30 * 60 * 1000); 

} else {
  const remaining = 3 - failedAttempts[clientIP];
  ws.close(4003, `WRONG_PASSWORD:${remaining}`);
}
    

  socket.addEventListener('error', () => {
    stopPingPong();
    resetLoginBtn();
    statusIndicator.className = "status-dot offline";
    connectionText.innerText = "কানেকশন এরর";
    connectionText.style.color = "#f87171";
  });
}

// 🟢 স্মার্ট পিং-পং লজিক (শুধু অ্যাপে বা এক্টিভ ট্যাবে থাকলেই চালু থাকবে)
function startPingPong() {
  stopPingPong();
  pingInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN && document.visibilityState === 'visible') {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20000);
}

function stopPingPong() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ট্যাব সুইচ করলে পিং স্মার্টলি অন/অফ হবে
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (socket && socket.readyState === WebSocket.OPEN) startPingPong();
  } else {
    stopPingPong(); // ট্যাব মিনিমাইজ করলে পিং অফ
  }
});

function resetLoginBtn() {
  loginBtn.disabled = false;
  loginBtnText.innerText = "চ্যাটরুমে প্রবেশ করুন";
  loginBtnIcon.className = "fa-solid fa-arrow-right";
  loginStatusMsg.classList.add('hidden');
}

function leaveChat() {
  stopPingPong();
  if (socket) socket.close();
  loginModal.classList.remove('hidden');
  loginStatusMsg.classList.add('hidden');
}

// 3. MESSAGE & CLOUDINARY
async function sendEncryptedPayload(type, rawData) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showAlert("সার্ভারে কানেকশন নেই!");
    return;
  }
  const rawPayload = JSON.stringify({ type, data: rawData });
  const encryptedString = await encryptData(rawPayload);
  socket.send(encryptedString);
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = '';
  await sendEncryptedPayload('text', text);
  appendChatMessage('You', { type: 'text', data: text }, true);
}

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

async function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  appendSystemMessage("📷 ছবি আপলোড হচ্ছে...");
  try {
    const url = await uploadToCloud(file);
    await sendEncryptedPayload('image', url);
    appendChatMessage('You', { type: 'image', data: url }, true);
  } catch (err) {
    showAlert("ছবি আপলোড ব্যর্থ হয়েছে!");
  }
  e.target.value = '';
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > MAX_DIRECT_SIZE) {
    pendingFileToUpload = file;
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    appendSystemMessage(`⏳ ফাইল সাইজ ${sizeMB} MB। হোস্ট অনুমতির অপেক্ষা করা হচ্ছে...`);
    
    socket.send(JSON.stringify({
      type: 'request_permission',
      fileName: file.name,
      fileSize: sizeMB + ' MB'
    }));
    e.target.value = '';
    return;
  }

  appendSystemMessage("📁 ফাইল আপলোড হচ্ছে...");
  try {
    const url = await uploadToCloud(file);
    await sendEncryptedPayload('file_link', { url: url, fileName: file.name });
    appendChatMessage('You', { type: 'file_link', data: { url: url, fileName: file.name } }, true);
  } catch (err) {
    showAlert("ফাইল আপলোড ব্যর্থ হয়েছে!");
  }
  e.target.value = '';
}

// 4. VOICE & LOCATION
async function toggleVoiceRecord() {
  const voiceText = document.getElementById('voiceText');
  const micIcon = document.getElementById('micIcon');

  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        appendSystemMessage("🎙️ ভয়েস মেসেজ আপলোড হচ্ছে...");
        const url = await uploadToCloud(audioBlob);
        await sendEncryptedPayload('audio', url);
        appendChatMessage('You', { type: 'audio', data: url }, true);
      };

      mediaRecorder.start();
      isRecording = true;
      voiceText.innerText = "রেকর্ড হচ্ছে...";
      micIcon.style.color = "#ef4444";
    } catch (err) {
      showAlert("মাইক্রোফোন পারমিশন পাওয়া যায়নি!");
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    voiceText.innerText = "ভয়েস";
    micIcon.style.color = "#fb7185";
  }
}

function sendLocation() {
  if (!navigator.geolocation) {
    showAlert("জিও-লোকেশন সাপোর্টেড নয়।");
    return;
  }

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const url = `https://www.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}`;
    await sendEncryptedPayload('location', url);
    appendChatMessage('You', { type: 'location', data: url }, true);
  }, () => {
    showAlert("লোকেশন পাওয়া যায়নি।");
  });
}

// 5. UI RENDER
function renderParsedMessage(sender, parsed) {
  appendChatMessage(sender, parsed, sender === username);
}

function appendChatMessage(sender, parsed, isSelf = false) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `msg-row ${isSelf ? 'self' : 'other'}`;

  const senderSpan = `<span class="msg-sender">${isSelf ? 'You' : escapeHtml(sender)}</span>`;
  
  let contentHtml = '';
  if (parsed.type === 'text') {
    contentHtml = `<div>${escapeHtml(parsed.data)}</div>`;
  } else if (parsed.type === 'image') {
    contentHtml = `<img src="${parsed.data}" class="chat-img" alt="ছবি"/>`;
  } else if (parsed.type === 'audio') {
    contentHtml = `<audio controls src="${parsed.data}" style="max-width:220px; margin-top:4px;"></audio>`;
  } else if (parsed.type === 'location') {
    contentHtml = `<a href="${parsed.data}" target="_blank" class="chat-link"><i class="fa-solid fa-map-location-dot"></i> 📍 মাই লোকেশন দেখুন</a>`;
  } else if (parsed.type === 'file_link') {
    contentHtml = `<a href="${parsed.data.url}" target="_blank" download class="chat-link"><i class="fa-solid fa-file-arrow-down"></i> 📁 ${escapeHtml(parsed.data.fileName)}</a>`;
  }

  msgDiv.innerHTML = `${senderSpan}<div class="msg-bubble">${contentHtml}</div>`;
  chatWindow.appendChild(msgDiv);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = "system-banner";
  div.innerHTML = `<span>${escapeHtml(text)}</span>`;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function showAlert(msg) {
  document.getElementById('modalTitle').innerText = "বিজ্ঞপ্তি";
  document.getElementById('modalMessage').innerText = msg;
  document.getElementById('modalButtons').innerHTML = `
    <button onclick="closeModal()" class="btn-primary" style="padding: 8px 16px; width: auto; font-size: 12px;">ঠিক আছে</button>
  `;
  document.getElementById('customModal').classList.remove('hidden');
}

function showApprovalModal(data) {
  document.getElementById('modalTitle').innerText = "হোস্ট পারমিশন রিকোয়েস্ট";
  document.getElementById('modalMessage').innerText = `${data.from} একটি ${data.fileSize} সাইজের ফাইল (${data.fileName}) পাঠাতে চাচ্ছে। অনুমতি দিবেন?`;
  document.getElementById('modalButtons').innerHTML = `
    <button onclick="respondPermission('${data.requesterId}', false)" class="btn-action">বাতিল</button>
    <button onclick="respondPermission('${data.requesterId}', true)" class="btn-primary" style="padding: 8px 16px; width: auto; font-size: 12px;">অনুমতি দিন</button>
  `;
  document.getElementById('customModal').classList.remove('hidden');
}

function respondPermission(targetUser, allowed) {
  socket.send(JSON.stringify({
    type: 'permission_response',
    targetUser: targetUser,
    allowed: allowed
  }));
  closeModal();
}

function closeModal() {
  document.getElementById('customModal').classList.add('hidden');
}
