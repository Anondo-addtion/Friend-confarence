
  // -------------------------------------------------------------
  // ১. পাসওয়ার্ড ও ইউজারনেম জোরপূর্বক চাওয়া (Loop until input)
  // -------------------------------------------------------------
  let enterPassword = "";
  while (!enterPassword || enterPassword.trim() === "") {
    enterPassword = prompt("🔑 Name:");
    if (enterPassword === null) {
      alert("Name required!");
    }
  }

  let USERNAME = "";
  while (!USERNAME || USERNAME.trim() === "") {
    USERNAME = prompt("👤 Name:");
    if (USERNAME === null) {
      alert("Name required!");
    }
  }

  // 🔑 ইনপুট নেওয়া পাসওয়ার্ডটিকেই এনক্রিপশন কী (Shared Secret) হিসেবে ব্যবহার করা হচ্ছে
  const SHARED_SECRET_PASSWORD = enterPassword; 
  
  // ☁️ Cloudinary ক্র্যাডেনশিয়াল
  const CLOUD_NAME = "bfq3wa5j";
  const UPLOAD_PRESET = "ml_defult";

  let isHost = false;

  function createDemoJWT(username) {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({ username: username }));
    return `${header}.${payload}.demo_signature`;
  }

  const token = createDemoJWT(USERNAME);

  // 🚀 Render-এর লাইভ WebSocket URL (এখানে আপনার আসল URL বসান)
  // ⚠️ মনে রাখবেন: http:// বা https:// এর জায়গায় wss:// ব্যবহার করতে হবে
  const RENDER_DOMAIN = "wss://chit-chat-qmva.onrender.com"; 
  const serverUrl = `wss://${RENDER_DOMAIN}?pass=${encodeURIComponent(enterPassword)}&token=${token}`; 
  
  const socket = new WebSocket(serverUrl);

  // 🔒 পাসওয়ার্ড ভুল হলে সার্ভার কানেকশন কেটে দিলে সাথে সাথে পেজ রিলোড হবে
  socket.addEventListener('close', (e) => {
    if (e.code === 4003) {
      alert("❌ ভুল পাসওয়ার্ড! প্রবেশ করা সম্ভব নয়।");
      window.location.reload(); 
    }
  });

  // সফল কানেকশন হলেই কেবল চ্যাট কার্ড দৃশ্যমান হবে
  socket.addEventListener('open', () => {
    document.getElementById('chatCard').style.display = 'block';
  });

  // AES-GCM এনক্রিপশন লজিক
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

  // UI Handlers
  const chatWindow = document.getElementById('chatWindow');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const imageInput = document.getElementById('imageInput');
  const fileInput = document.getElementById('fileInput');
  const voiceBtn = document.getElementById('voiceBtn');
  const locationBtn = document.getElementById('locationBtn');
  const roleBadge = document.getElementById('roleBadge');

  let pendingFileToUpload = null;
  const MAX_DIRECT_SIZE = 10 * 1024 * 1024; 

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
      appendChat('System', 'ছবি ক্লাউডে আপলোড হচ্ছে...');
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

    appendChat('System', 'ফাইল আপলোড হচ্ছে...');
    const url = await uploadToCloud(file);
    await sendEncryptedPayload('file_link', { url: url, fileName: file.name });
    appendChat('You', `<a href="${url}" target="_blank">📁 ${file.name} (ডাউনলোড)</a>`);
  });

  // ইনকামিং বার্তা হ্যান্ডলার
  socket.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.system) {
        if (data.type === 'role_assign') {
          isHost = data.isHost;
          roleBadge.style.display = isHost ? 'inline-block' : 'none';
          if(isHost) appendChat('System', '🌟 আপনি এখন চ্যাটরুমের Host!');
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
        const approved = confirm(`${data.from} একটি ${data.fileSize} সাইজের ফাইল (${data.fileName}) পাঠাতে চায়। অনুমতি দেবেন?`);
        socket.send(JSON.stringify({
          type: 'permission_response',
          targetUser: data.requesterId,
          allowed: approved
        }));
        return;
      }

      if (data.type === 'permission_result') {
        if (data.allowed && pendingFileToUpload) {
          alert("হোস্ট অনুমতি দিয়েছেন! আপলোড শুরু হচ্ছে...");
          const url = await uploadToCloud(pendingFileToUpload);
          await sendEncryptedPayload('file_link', { url: url, fileName: pendingFileToUpload.name });
          appendChat('You', `<a href="${url}" target="_blank">📁 ${pendingFileToUpload.name} (ডাউনলোড)</a>`);
          pendingFileToUpload = null;
        } else {
          alert("হোস্ট অনুমতি দেননি!");
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
    else if (parsed.type === 'location') appendChat(sender, `<a href="${parsed.data}" target="_blank">📍 লোকেশন</a>`);
    else if (parsed.type === 'file_link') appendChat(sender, `<a href="${parsed.data.url}" target="_blank">📁 ${parsed.data.fileName} (ডাউনলোড)</a>`);
  }
