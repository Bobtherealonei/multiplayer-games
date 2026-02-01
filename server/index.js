const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const GameManager = require('./gameManager');
const Matchmaking = require('./matchmaking');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*", // Set CLIENT_URL in production
    methods: ["GET", "POST"],
    credentials: true
  }
});

const gameManager = new GameManager(io);
const matchmaking = new Matchmaking(gameManager);

// Redirect root to game selection (must be before static middleware)
app.get('/', (req, res) => {
  res.sendFile('games.html', { root: '../client' });
});

// Serve static files from client directory
app.use(express.static('../client', { index: false }));

// Store user ID mapping: socket.id -> userId
const socketToUserId = new Map();
const userIdToSocket = new Map();

io.on('connection', (socket) => {
  // Get user ID from connection query params (sent via connectParams in iOS)
  // Falls back to socket.id for web clients that don't send userId
  const userId = socket.handshake.query?.userId || 
                 socket.handshake.auth?.userId || 
                 socket.id;
  
  // Store mapping
  socketToUserId.set(socket.id, userId);
  userIdToSocket.set(userId, socket);
  
  // Store userId on socket for easy access
  socket.userId = userId;
  
  console.log(`Player connected: socket.id=${socket.id}, userId=${userId}`);

  socket.on('findMatch', (data) => {
    const gameType = data?.gameType || 'ticTacToe'; // Default to ticTacToe for backward compatibility
    matchmaking.addPlayer(socket, gameType, userId);
  });

  socket.on('makeMove', (data) => {
    console.log('Received makeMove from', userId, '(socket:', socket.id, ') data:', JSON.stringify(data));
    // Handle case where data might be wrapped in an array
    const moveData = Array.isArray(data) ? data[0] : data;
    gameManager.handleMove(userId, moveData);
  });

  // ✅ Chat relay
  socket.on('chatMessage', (data) => {
    const payload = Array.isArray(data) ? data[0] : data;
    gameManager.handleChat(userId, payload);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: userId=${userId}, socket.id=${socket.id}`);
    matchmaking.removePlayer(userId);
    gameManager.handleDisconnect(userId);
    // Clean up mappings
    socketToUserId.delete(socket.id);
    userIdToSocket.delete(userId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
