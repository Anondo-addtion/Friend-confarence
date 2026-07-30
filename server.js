// server.js
require('dotenv').config(); // 👈 একদম ১ নম্বর লাইনে এটি বসান

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 8080;
const SECRET_KEY = 'my_super_secret_chat_key';

// 🔑 এখানে আপনার চ্যাটের গোপন পাসওয়ার্ড সেট করুন
const CHAT_PASSWORD = process.env.CHAT_PASSWORD; 

const wss = new WebSocket.Server({ 
  port: PORT,
  maxPayload: 15 * 1024 * 1024 
});

let connectedUsers = [];
let messageHistory = [];

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  messageHistory = messageHistory.filter(msg => (now - msg.timestamp) < TWO_DAYS_MS);
}, 60 * 60 * 1000);

console.log(`Server running on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', ''));
  const password = urlParams.get('pass');
  const token = urlParams.get('token');

  // 🔒 ১. পাসওয়ার্ড ভুল বা ফাঁকা হলে কানেকশন কেটে রিজেক্ট করবে (Code 4003)
  if (!password || password !== CHAT_PASSWORD) {
    ws.close(4003, 'Invalid Password');
    return;
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    ws.username = decoded.username;
  } catch (err) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.id = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  
  // প্রথম প্রবেশকারী ব্যক্তি স্বয়ংক্রিয়ভাবে হোস্ট হবে
  const isFirstUser = connectedUsers.length === 0;
  ws.isHost = isFirstUser;
  connectedUsers.push(ws);

  // রোল এবং ২ দিনের হিস্ট্রি পাঠানো
  ws.send(JSON.stringify({ system: true, type: 'role_assign', isHost: ws.isHost }));

  const validHistory = messageHistory.filter(msg => (Date.now() - msg.timestamp) < TWO_DAYS_MS);
  ws.send(JSON.stringify({ system: true, type: 'history', messages: validHistory.map(m => m.data) }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'request_permission') {
        const currentHost = connectedUsers.find(u => u.isHost);
        if (currentHost && currentHost.readyState === WebSocket.OPEN) {
          currentHost.send(JSON.stringify({
            type: 'host_approval_required',
            from: ws.username,
            fileName: data.fileName,
            fileSize: data.fileSize,
            requesterId: ws.id
          }));
        }
        return;
      }

      if (data.type === 'permission_response') {
        const targetClient = connectedUsers.find(u => u.id === data.targetUser);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          targetClient.send(JSON.stringify({
            type: 'permission_result',
            allowed: data.allowed
          }));
        }
        return;
      }
    } catch (e) {}

    messageHistory.push({
      timestamp: Date.now(),
      data: { sender: ws.username, payload: message.toString() }
    });

    connectedUsers.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          sender: ws.username,
          payload: message.toString()
        }));
      }
    });
  });

  ws.on('close', () => {
    connectedUsers = connectedUsers.filter(u => u !== ws);
    if (ws.isHost && connectedUsers.length > 0) {
      connectedUsers[0].isHost = true;
      connectedUsers[0].send(JSON.stringify({ system: true, type: 'role_assign', isHost: true }));
    }
  });
});
