require('dotenv').config();

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 8080;
const SECRET_KEY = process.env.SECRET_KEY || 'my_super_secret_chat_key';
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || '123456'; // Render Environment Variable থেকে নেয়া হবে

const wss = new WebSocket.Server({
  port: PORT,
  maxPayload: 15 * 1024 * 1024 // ১৫ মেগাবাইট সর্বোচ্চ পেলোড
});

let connectedUsers = [];
let messageHistory = [];

// ৪৮ ঘণ্টার বেশি পুরোনো মেসেজ হিস্ট্রি স্বয়ংক্রিয়ভাবে মুছে ফেলা
setInterval(() => {
  const now = Date.now();
  messageHistory = messageHistory.filter(msg => (now - msg.timestamp) < 48 * 60 * 60 * 1000);
}, 60 * 60 * 1000);

console.log(`WebSocket Server start on port ${PORT}`);

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
    const decoded = jwt.decode(token); // Demo client JWT Verify
    ws.username = (decoded && decoded.username) ? decoded.username : 'Anonymous';
  } catch (err) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
  
  // প্রথম কানেক্ট হওয়া ইউজারকে হোস্ট বানানো
  const isHost = connectedUsers.length === 0;
  ws.isHost = isHost;
  connectedUsers.push(ws);

  // হোস্ট রোল ব্যাকএন্ড থেকে ক্লায়েন্টে পাঠানো
  ws.send(JSON.stringify({
    system: true,
    type: 'role_assign',
    isHost: isHost
  }));

  // পূর্ববর্তী মেসেজ হিস্ট্রি নতুন ইউজারকে পাঠানো
  if (messageHistory.length > 0) {
    ws.send(JSON.stringify({
      system: true,
      type: 'history',
      messages: messageHistory
    }));
  }

  // 📩 ইনকামিং মেসেজ হ্যান্ডলিং
  ws.on('message', (message) => {
    try {
      const msgString = message.toString();
      
      // ফাইল পারমিশন ও হোস্ট এপ্রুভাল রিকোয়েস্ট চেক
      if (msgString.startsWith('{')) {
        const parsedJSON = JSON.parse(msgString);
        
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

      // চ্যাট মেসেজ হিস্ট্রিতে সংরক্ষণ করা
      messageHistory.push({
        sender: ws.username,
        payload: msgString,
        timestamp: Date.now()
      });

      // অন্য সকল ইউজারদের কাছে মেসেজ ব্রডকাস্ট করা
      connectedUsers.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            sender: ws.username,
            payload: msgString
          }));
        }
      });

    } catch (err) {
      console.error('Message Processing Error:', err);
    }
  });

  // 🚪 ইউজার ডিসকানেক্ট হলে
  ws.on('close', () => {
    connectedUsers = connectedUsers.filter(u => u !== ws);
    
    // হোস্ট বের হয়ে গেলে পরবর্তী ইউজারকে নতুন হোস্ট বানানো
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


