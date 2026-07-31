require('dotenv').config();

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 8080;
const SECRET_KEY = process.env.SECRET_KEY || 'my_super_secret_chat_key';
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || '123456'; 

const wss = new WebSocket.Server({
  port: PORT,
  maxPayload: 15 * 1024 * 1024
});

let connectedUsers = [];
let messageHistory = [];

// ৪৮ ঘণ্টার বেশি পুরোনো মেসেজ হিস্ট্রি রিমুভ করা
setInterval(() => {
  const now = Date.now();
  messageHistory = messageHistory.filter(msg => (now - msg.timestamp) < 48 * 60 * 60 * 1000);
}, 60 * 60 * 1000);

console.log(`Server running on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', ''));
  const password = urlParams.get('pass');
  const token = urlParams.get('token');

  // 🔒 ১. পাসওয়ার্ড ভ্যালিডেশন
  if (!password || password !== CHAT_PASSWORD) {
    ws.close(4003, 'Invalid Password');
    return;
  }

  // 🔑 ২. টোকেন ভ্যালিডেশন
  try {
    const decoded = jwt.decode(token);
    ws.username = (decoded && decoded.username) ? decoded.username : 'Anonymous';
  } catch (err) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
  ws.isAlive = true;
  
  // প্রথম ইউজারকে Host বানানো
  const isHost = connectedUsers.length === 0;
  ws.isHost = isHost;
  connectedUsers.push(ws);

  // হোস্ট রোল পাঠানো
  ws.send(JSON.stringify({
    system: true,
    type: 'role_assign',
    isHost: isHost
  }));

  // আগের মেসেজ হিস্ট্রি পাঠানো
  if (messageHistory.length > 0) {
    ws.send(JSON.stringify({
      system: true,
      type: 'history',
      messages: messageHistory
    }));
  }

  // 📩 মেসেজ হ্যান্ডেল করা
  ws.on('message', (message) => {
    try {
      const msgString = message.toString();

      // Ping-Pong Keepalive Logic
      if (msgString.startsWith('{')) {
        const parsedJSON = JSON.parse(msgString);

        if (parsedJSON.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (parsedJSON.type === 'request_permission') {
          const hostUser = connectedUsers.find(u => u.isHost);
          if (hostUser) {
            hostUser.send(JSON.stringify({
              system: true,
              type: 'host_approval_required',
              requesterId: ws.id,
              from: ws.username,
              fileName: parsedJSON.fileName,
              fileSize: parsedJSON.fileSize
            }));
          }
          return;
        }

        if (parsedJSON.type === 'permission_response') {
          const targetUser = connectedUsers.find(u => u.id === parsedJSON.targetUser);
          if (targetUser) {
            targetUser.send(JSON.stringify({
              system: true,
              type: 'permission_result',
              allowed: parsedJSON.allowed
            }));
          }
          return;
        }
      }

      // সাধারণ চ্যাট মেসেজ হিস্ট্রিতে রাখা
      messageHistory.push({
        sender: ws.username,
        payload: msgString,
        timestamp: Date.now()
      });

      // ব্রডকাস্ট মেসেজ
      connectedUsers.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            sender: ws.username,
            payload: msgString
          }));
        }
      });

    } catch (err) {
      console.error('Message Process Error:', err);
    }
  });

  // 🚪 ইউজার ডিসকানেক্ট হলে
  ws.on('close', () => {
    connectedUsers = connectedUsers.filter(u => u !== ws);
    
    if (ws.isHost && connectedUsers.length > 0) {
      connectedUsers[0].isHost = true;
      connectedUsers[0].send(JSON.stringify({
        system: true,
        type: 'role_assign',
        isHost: true
      }));
    }
  });
});
