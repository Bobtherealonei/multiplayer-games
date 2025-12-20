class Matchmaking {
  constructor(gameManager) {
    this.gameManager = gameManager;
    this.queues = new Map(); // gameType -> [players]
  }

  addPlayer(socket, gameType) {
    // Validate gameType
    if (!gameType) {
      socket.emit('matchmakingStatus', { status: 'error', error: 'gameType is required' });
      return;
    }

    // Initialize queue for gameType if it doesn't exist
    if (!this.queues.has(gameType)) {
      this.queues.set(gameType, []);
    }

    const queue = this.queues.get(gameType);

    // Check if player is already in queue for this gameType
    if (queue.find(p => p.id === socket.id)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInQueue' });
      return;
    }

    // Check if player is already in a game
    if (this.gameManager.isPlayerInGame(socket.id)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInGame' });
      return;
    }

    const player = {
      id: socket.id,
      socket: socket,
      gameType: gameType,
      joinedAt: Date.now()
    };

    queue.push(player);
    socket.emit('matchmakingStatus', { status: 'searching', gameType: gameType });

    // Try to find a match for this gameType
    this.tryMatchmaking(gameType);
  }

  removePlayer(playerId) {
    // Remove player from all queues
    for (const [gameType, queue] of this.queues.entries()) {
      const index = queue.findIndex(p => p.id === playerId);
      if (index !== -1) {
        queue.splice(index, 1);
        break;
      }
    }
  }

  tryMatchmaking(gameType) {
    const queue = this.queues.get(gameType);
    if (!queue || queue.length < 2) {
      return;
    }

    // Match the first two players for this gameType
    const player1 = queue.shift();
    const player2 = queue.shift();

    // Create a new game with the specified gameType
    this.gameManager.createGame(player1, player2, gameType);
  }
}

module.exports = Matchmaking;

