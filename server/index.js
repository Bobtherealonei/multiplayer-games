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

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('findMatch', (data) => {
    const gameType = data?.gameType || 'ticTacToe'; // Default to ticTacToe for backward compatibility
    matchmaking.addPlayer(socket, gameType);
  });

  socket.on('makeMove', (data) => {
    console.log('Received makeMove from', socket.id, 'data:', JSON.stringify(data));
    // Handle case where data might be wrapped in an array
    const moveData = Array.isArray(data) ? data[0] : data;
    gameManager.handleMove(socket.id, moveData);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    matchmaking.removePlayer(socket.id);
    gameManager.handleDisconnect(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

