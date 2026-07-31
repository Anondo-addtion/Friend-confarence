    // -------------------------------------------------------------
    // CONFIGURATION & GLOBAL VARIABLES
    // -------------------------------------------------------------
    const CLOUD_NAME = "bfq3wa5j";       // Cloudinary Name
    const UPLOAD_PRESET = "ml_defult";  // Cloudinary Preset

    let socket = null;
    let username = "";
    let password = "";
    let cryptoKey = null;
    let isHost = false;
    let pendingFileToUpload = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    const MAX_DIRECT_SIZE = 10 * 1024 * 1024; // 10MB

    // DOM Elements
    const loginModal = document.getElementById('loginModal');
    const chatWindow = document.getElementById('chatWindow');
    const messageInput = document.getElementById('messageInput');
    const statusIndicator = document.getElementById('statusIndicator');
    const connectionText = document.getElementById('connectionText');
    const hostBadge = document.getElementById('hostBadge');

    // -------------------------------------------------------------
    // 1. ENCRYPTION ENGINE (PBKDF2 + AES-GCM)
    // -------------------------------------------------------------
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

    // -------------------------------------------------------------
    // 2. WEBSOCKET CONNECTION
    // -------------------------------------------------------------
    async function startConnection() {
      username = document.getElementById('usernameInput').value.trim();
      password = document.getElementById('passwordInput').value.trim();
      let serverUrl = document.getElementById('serverUrlInput').value.trim();

      if (!username || !password || !serverUrl) {
        showAlert("অনুগ্রহ করে সকল তথ্য পূরণ করুন।");
        return;
      }

      loginModal.classList.add('hidden');
      await initCrypto(password);

      const token = createDemoJWT(username);
      const fullUrl = `${serverUrl}?pass=${encodeURIComponent(password)}&token=${encodeURIComponent(token)}`;

      connectionText.innerText = "সার্ভারে সংযুক্ত হচ্ছে...";
      
      socket = new WebSocket(fullUrl);

      socket.addEventListener('open', () => {
        statusIndicator.className = "absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-slate-900 rounded-full";
        connectionText.innerText = "সংযুক্ত রয়েছে (Encrypted)";
        connectionText.className = "text-xs text-emerald-400";
        appendSystemMessage("🔒 নিরাপদভাবে চ্যাটরুমে যুক্ত হয়েছেন।");
      });

      socket.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data);

          // সিস্টেম মেসেজ হ্যান্ডলিং
          if (data.system) {
            if (data.type === 'role_assign') {
              isHost = data.isHost;
              hostBadge.style.display = isHost ? 'inline-flex' : 'none';
              if (isHost) appendSystemMessage("🌟 আপনি এখন এই চ্যাটারুমের হোস্ট (Host)।");
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
                appendSystemMessage("✅ হোস্ট ফাইল আপলোডের অনুমতি দিয়েছে। আপলোড শুরু হচ্ছে...");
                const url = await uploadToCloud(pendingFileToUpload);
                await sendEncryptedPayload('file_link', { url: url, fileName: pendingFileToUpload.name });
                appendChatMessage('You', { type: 'file_link', data: { url: url, fileName: pendingFileToUpload.name } }, true);
                pendingFileToUpload = null;
              } else {
                showAlert("❌ হোস্ট ফাইল আপলোডের অনুমতি প্রত্যাখ্যান করেছে।");
                pendingFileToUpload = null;
              }
            }
            return;
          }

          // ডিসিপ্ট মেসেজ প্রসেসিং
          const decryptedString = await decryptData(data.payload);
          try {
            const parsed = JSON.parse(decryptedString);
            renderParsedMessage(data.sender, parsed);
          } catch {
            renderParsedMessage(data.sender, { type: 'text', data: decryptedString });
          }

        } catch (err) {
          console.error("Error processing message:", err);
        }
      });

      socket.addEventListener('close', (e) => {
        statusIndicator.className = "absolute bottom-0 right-0 w-3 h-3 bg-rose-500 border-2 border-slate-900 rounded-full";
        connectionText.innerText = "ডিসকানেক্ট হয়েছে";
        connectionText.className = "text-xs text-rose-400";

        if (e.code === 4003) {
          showAlert("❌ ভুল পাসওয়ার্ড! অনুগ্রহ করে সঠিক পাসওয়ার্ড দিয়ে পেজ রিলোড করুন।");
        } else {
          appendSystemMessage("⚠️ সার্ভার ডিসকানেক্ট হয়েছে। পুনরায় চেষ্টা করুন।");
        }
      });

      socket.addEventListener('error', () => {
        statusIndicator.className = "absolute bottom-0 right-0 w-3 h-3 bg-rose-500 border-2 border-slate-900 rounded-full";
        connectionText.innerText = "কানেকশন এরর";
        connectionText.className = "text-xs text-rose-400";
      });
    }

    function leaveChat() {
      if (socket) socket.close();
      location.reload();
    }

    // -------------------------------------------------------------
    // 3. MESSAGE SENDING & CLOUDINARY UPLOAD
    // -------------------------------------------------------------
    async function sendEncryptedPayload(type, rawData) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        showAlert("সার্ভারে কোনো সক্রিয় সংযোগ নেই!");
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

      appendSystemMessage("📷 ছবি আপলোড হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন...");
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
        appendSystemMessage(`⏳ ফাইল সাইজ ${sizeMB} MB। হোস্টের অনুমোদনের জন্য রিকোয়েস্ট পাঠানো হয়েছে...`);
        
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

    // -------------------------------------------------------------
    // 4. VOICE RECORDING & LOCATION
    // -------------------------------------------------------------
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
          micIcon.className = "fa-solid fa-stop text-rose-500 animate-pulse";
        } catch (err) {
          showAlert("মাইক্রোফোন এক্সেস পাওয়া যায়নি!");
        }
      } else {
        mediaRecorder.stop();
        isRecording = false;
        voiceText.innerText = "ভয়েস";
        micIcon.className = "fa-solid fa-microphone text-rose-400";
      }
    }

    function sendLocation() {
      if (!navigator.geolocation) {
        showAlert("আপনার ব্রাউজারে জিও-লোকেশন সার্পোট করে না।");
        return;
      }

      navigator.geolocation.getCurrentPosition(async (pos) => {
        const url = `https://www.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}`;
        await sendEncryptedPayload('location', url);
        appendChatMessage('You', { type: 'location', data: url }, true);
      }, () => {
        showAlert("লোকেশন নির্ণয় করা সম্ভব হয়নি।");
      });
    }

    //
   -------------------------------------------------------------
    // 5. UI RENDER FUNCTIONS
    // -------------------------------------------------------------
    function renderParsedMessage(sender, parsed) {
      appendChatMessage(sender, parsed, sender === username);
    }

    function appendChatMessage(sender, parsed, isSelf = false) {
      const msgDiv = document.createElement('div');
      msgDiv.className = `flex flex-col ${isSelf ? 'items-end' : 'items-start'} mb-3`;

      const senderSpan = `<span class="text-[11px] font-medium text-slate-400 mb-1 px-1">${isSelf ? 'You' : sender}</span>`;
      
      let contentHtml = '';
      if (parsed.type === 'text') {
        contentHtml = `<div class="break-words text-sm text-slate-100">${escapeHtml(parsed.data)}</div>`;
      } else if (parsed.type === 'image') {
        contentHtml = `<img src="${parsed.data}" class="max-w-[220px] sm:max-w-xs rounded-lg border border-slate-700 shadow-md my-1" alt="ছবি"/>`;
      } else if (parsed.type === 'audio') {
        contentHtml = `<audio controls src="${parsed.data}" class="max-w-[240px] my-1"></audio>`;
      } else if (parsed.type === 'location') {
        contentHtml = `<a href="${parsed.data}" target="_blank" class="inline-flex items-center gap-2 bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 px-3 py-2 rounded-xl text-xs hover:underline">
          <i class="fa-solid fa-map-location-dot text-base"></i> 📍 মাই লোকেশন দেখুন
        </a>`;
      } else if (parsed.type === 'file_link') {
        contentHtml = `<a href="${parsed.data.url}" target="_blank" download class="inline-flex items-center gap-2 bg-sky-600/20 text-sky-300 border border-sky-500/30 px-3 py-2 rounded-xl text-xs hover:underline">
          <i class="fa-solid fa-file-arrow-down text-base"></i> 📁 ${escapeHtml(parsed.data.fileName)} (ডাউনলোড)
        </a>`;
      }

      const bubbleClass = isSelf 
        ? 'bg-indigo-600/90 text-white border border-indigo-500/50 rounded-2xl rounded-tr-xs px-4 py-2.5 max-w-[80%] shadow-md'
        : 'bg-slate-800 text-slate-100 border border-slate-700 rounded-2xl rounded-tl-xs px-4 py-2.5 max-w-[80%] shadow-md';

      msgDiv.innerHTML = `${senderSpan}<div class="${bubbleClass}">${contentHtml}</div>`;
      chatWindow.appendChild(msgDiv);
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    function appendSystemMessage(text) {
      const div = document.createElement('div');
      div.className = "text-center my-2";
      div.innerHTML = `<span class="bg-slate-800/60 border border-slate-700/40 text-slate-400 text-xs px-3 py-1 rounded-full inline-block">${escapeHtml(text)}</span>`;
      chatWindow.appendChild(div);
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }
    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    // Modal Helpers
    function showAlert(msg) {
      document.getElementById('modalTitle').innerText = "বিজ্ঞপ্তি";
      document.getElementById('modalMessage').innerText = msg;
      document.getElementById('modalButtons').innerHTML = `
        <button onclick="closeModal()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg font-medium">ঠিক আছে</button>
      `;
      document.getElementById('customModal').classList.remove('hidden');
    }

    function showApprovalModal(data) {
      document.getElementById('modalTitle').innerText = "হোস্ট পারমিশন রিকোয়েস্ট";
      document.getElementById('modalMessage').innerText = `${data.from} একটি ${data.fileSize} সাইজের ফাইল (${data.fileName}) পাঠাতে চাচ্ছে। অনুমতি দিবেন?`;
      document.getElementById('modalButtons').innerHTML = `
        <button onclick="respondPermission('${data.requesterId}', false)" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg">বাতিল</button>
        <button onclick="respondPermission('${data.requesterId}', true)" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg font-medium">অনুমতি দিন</button>
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