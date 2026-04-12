class Matchmaking {
  constructor(gameManager) {
    this.gameManager = gameManager;
    this.queues = new Map(); // gameType -> [players]
  }

  addPlayer(socket, gameType, userId) {
    // Validate gameType
    if (!gameType) {
      socket.emit('matchmakingStatus', { status: 'error', error: 'gameType is required' });
      return;
    }

    // If the player got stuck in any queue from an older search or reconnect,
    // drop the stale entry and enqueue the current socket fresh.
    this.removePlayer(userId);

    // Check if player is already in a game (using userId)
    if (this.gameManager.isPlayerInGame(userId)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInGame' });
      return;
    }

    // Initialize queue for gameType if it doesn't exist
    if (!this.queues.has(gameType)) {
      this.queues.set(gameType, []);
    }

    const queue = this.queues.get(gameType);
    const player = {
      id: userId, // Use Firebase user ID instead of socket.id
      socket: socket,
      gameType: gameType,
      joinedAt: Date.now()
    };

    queue.push(player);
    socket.emit('matchmakingStatus', { status: 'searching', gameType: gameType });

    // Try to find a match for this gameType
    this.tryMatchmaking(gameType);
  }

  removePlayer(userId) {
    // Remove player from all queues using userId
    for (const [gameType, queue] of this.queues.entries()) {
      const index = queue.findIndex(p => p.id === userId);
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

