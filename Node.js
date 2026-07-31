require('dotenv').config();
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 8080;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || '123456'; 

const wss = new WebSocket.Server({
  port: PORT,
  maxPayload: 15 * 1024 * 1024
});

let connectedUsers = [];
let messageHistory = [];

// 🔒 IP Block Counter Tracker
const failedAttempts = {}; 
const blockedIPs = new Set(); 

console.log(`Server running on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // ১. IP ইতিমধ্যেই ব্লকড কি না চেক
  if (blockedIPs.has(clientIP)) {
    ws.close(4003, 'IP_BLOCKED');
    return;
  }

  const urlParams = new URLSearchParams(req.url.replace('/?', ''));
  const password = urlParams.get('pass');
  const token = urlParams.get('token');

  // ২. পাসওয়ার্ড সিকিউরিটি লজিক ও কাউন্টার
  if (!password || password !== CHAT_PASSWORD) {
    failedAttempts[clientIP] = (failedAttempts[clientIP] || 0) + 1;

    if (failedAttempts[clientIP] >= 3) {
      blockedIPs.add(clientIP);
      console.log(`IP Blocked: ${clientIP}`);
      ws.close(4003, 'IP_BLOCKED');
    } else {
      const remaining = 3 - failedAttempts[clientIP];
      ws.close(4003, `WRONG_PASSWORD:${remaining}`);
    }
    return;
  }

  // সঠিক পাসওয়ার্ড দিলে কাউন্টার জিরো
  failedAttempts[clientIP] = 0;

  try {
    const decoded = jwt.decode(token);
    ws.username = (decoded && decoded.username) ? decoded.username : 'Anonymous';
  } catch (err) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
  ws.isAlive = true;
  
  const isHost = connectedUsers.length === 0;
  ws.isHost = isHost;
  connectedUsers.push(ws);

  ws.send(JSON.stringify({
    system: true,
    type: 'role_assign',
    isHost: isHost
  }));

  if (messageHistory.length > 0) {
    ws.send(JSON.stringify({
      system: true,
      type: 'history',
      messages: messageHistory
    }));
  }

  ws.on('message', (message) => {
    try {
      const msgString = message.toString();

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

      messageHistory.push({
        sender: ws.username,
        payload: msgString,
        timestamp: Date.now()
      });

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
