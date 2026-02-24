/**
 * Base Game Class - Template for all multiplayer games
 * 
 * All games must implement:
 * - createGame(players) - Initialize game with players
 * - makeMove(player, move) - Process a move from a player
 * - getState() - Return current game state
 * - isFinished() - Check if game is over
 * - cleanup() - Clean up any resources
 */
class Game {
  constructor() {
    this.players = [];
    this.gameId = null;
    this.createdAt = null;
  }

  /**
   * Initialize the game with players
   * @param {Array} players - Array of player objects with {id, socket, ...}
   * @returns {Object} Initialization result
   */
  createGame(players) {
    throw new Error('createGame(players) must be implemented by subclass');
  }

  /**
   * Process a move from a player
   * @param {string} playerId - ID of the player making the move
   * @param {Object} move - Move data (game-specific)
   * @returns {Object} Result with success flag and optional error/data
   */
  makeMove(playerId, move) {
    throw new Error('makeMove(playerId, move) must be implemented by subclass');
  }

  /**
   * Get the current state of the game
   * @returns {Object} Current game state
   */
  getState() {
    throw new Error('getState() must be implemented by subclass');
  }

  /**
   * Check if the game is finished
   * @returns {boolean} True if game is over, false otherwise
   */
  isFinished() {
    throw new Error('isFinished() must be implemented by subclass');
  }

  /**
   * Clean up any resources (timers, listeners, etc.)
   */
  cleanup() {
    // Default implementation - can be overridden
    this.players = [];
  }
}

module.exports = Game;

