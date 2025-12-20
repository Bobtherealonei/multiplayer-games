const socket = io();

let currentSymbol = null;
let gameState = null;
let rows = 6;
let cols = 7;

// DOM elements
const statusEl = document.getElementById('status');
const findMatchBtn = document.getElementById('findMatchBtn');
const matchmakingEl = document.getElementById('matchmaking');
const gameContainerEl = document.getElementById('gameContainer');
const playerInfoEl = document.getElementById('playerInfo');
const turnInfoEl = document.getElementById('turnInfo');
const boardEl = document.getElementById('board');
const gameResultEl = document.getElementById('gameResult');

// Initialize board
function initializeBoard() {
    boardEl.innerHTML = '';
    boardEl.className = 'board connect4-board';
    
    // Create game board - cells are clickable by column
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.row = row;
            cell.dataset.col = col;
            // Clicking any cell in a column drops a piece in that column
            cell.addEventListener('click', () => handleColumnClick(col));
            boardEl.appendChild(cell);
        }
    }
}

// Handle column click
function handleColumnClick(column) {
    if (!gameState || gameState.winner || gameState.isDraw) {
        return;
    }

    if (gameState.currentPlayer !== currentSymbol) {
        return;
    }

    socket.emit('makeMove', { column });
}

// Update board display
function updateBoard() {
    if (!gameState) return;

    const cells = boardEl.querySelectorAll('.cell');
    gameState.board.forEach((row, rowIndex) => {
        row.forEach((value, colIndex) => {
            const cellIndex = rowIndex * cols + colIndex;
            const cell = cells[cellIndex];
            if (cell) {
                cell.className = 'cell';
                
                if (value === 'R') {
                    cell.classList.add('red');
                } else if (value === 'Y') {
                    cell.classList.add('yellow');
                }
                
                // Disable cells if game is over or not player's turn
                if (gameState.winner || gameState.isDraw || gameState.currentPlayer !== currentSymbol) {
                    cell.classList.add('disabled');
                } else {
                    // Check if column is full
                    const isFull = gameState.board[0][colIndex] !== null;
                    if (isFull) {
                        cell.classList.add('disabled');
                    } else {
                        cell.classList.remove('disabled');
                    }
                }
            }
        });
    });
    
    // Highlight winning cells if there's a winner
    if (gameState.winner) {
        highlightWinningCells();
    }
}

// Highlight winning cells (simplified - would need server to send winning positions)
function highlightWinningCells() {
    // This would ideally be sent from the server
    // For now, we'll just show the winner message
}

// Update game info
function updateGameInfo() {
    if (!gameState) return;

    // Update status display with colored badges
    if (gameState.winner) {
        if (gameState.winner === currentSymbol) {
            const winnerName = currentSymbol === 'R' ? 'Red' : 'Yellow';
            statusEl.innerHTML = `<span class="winner-message">🎉 You Win! (${winnerName}) 🎉</span>`;
            statusEl.className = 'status';
        } else {
            const winnerName = gameState.winner === 'R' ? 'Red' : 'Yellow';
            statusEl.innerHTML = `<span class="winner-message">Player ${gameState.winner === 'R' ? '1' : '2'} (${winnerName}) Wins!</span>`;
            statusEl.className = 'status';
        }
        playerInfoEl.textContent = '';
        turnInfoEl.textContent = '';
    } else if (gameState.isDraw) {
        statusEl.innerHTML = '<span class="winner-message">It\'s a Draw!</span>';
        statusEl.className = 'status';
        playerInfoEl.textContent = '';
        turnInfoEl.textContent = '';
    } else {
        const currentPlayerName = gameState.currentPlayer === 'R' ? 'Red' : 'Yellow';
        const playerNum = gameState.currentPlayer === 'R' ? '1' : '2';
        
        if (gameState.currentPlayer === currentSymbol) {
            statusEl.className = `status current-player ${gameState.currentPlayer === 'R' ? 'player-red' : 'player-yellow'}`;
            statusEl.textContent = `Your Turn (${currentPlayerName})`;
        } else {
            statusEl.className = `status current-player ${gameState.currentPlayer === 'R' ? 'player-red' : 'player-yellow'}`;
            statusEl.textContent = `Player ${playerNum}'s Turn (${currentPlayerName})`;
        }
        playerInfoEl.textContent = '';
        turnInfoEl.textContent = '';
    }
}

// Socket event handlers
socket.on('connect', () => {
    updateStatus('Connected to server', 'connected');
});

socket.on('disconnect', () => {
    updateStatus('Disconnected from server', 'error');
    resetGame();
});

socket.on('matchmakingStatus', (data) => {
    if (data.status === 'searching') {
        updateStatus('Searching for opponent...', 'searching');
        findMatchBtn.disabled = true;
        findMatchBtn.textContent = 'Searching...';
    } else if (data.status === 'alreadyInQueue') {
        updateStatus('Already in queue', 'searching');
    } else if (data.status === 'alreadyInGame') {
        updateStatus('You are already in a game', 'error');
    }
});

socket.on('gameFound', (data) => {
    currentSymbol = data.symbol;
    updateStatus('Match found! Game starting...', 'connected');
    findMatchBtn.disabled = false;
    findMatchBtn.textContent = 'Find Match';
    matchmakingEl.classList.add('hidden');
    gameContainerEl.classList.remove('hidden');
    
    // Update dimensions if provided
    if (data.rows) rows = data.rows;
    if (data.cols) cols = data.cols;
    
    initializeBoard();
});

socket.on('gameState', (state) => {
    gameState = state;
    if (state.rows) rows = state.rows;
    if (state.cols) cols = state.cols;
    updateBoard();
    updateGameInfo();
});

socket.on('moveError', (data) => {
    alert(data.error);
});

socket.on('opponentDisconnected', () => {
    updateStatus('Opponent disconnected', 'error');
    setTimeout(() => {
        resetGame();
    }, 2000);
});

// UI helpers
function updateStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
}

function resetGame() {
    currentSymbol = null;
    gameState = null;
    matchmakingEl.classList.remove('hidden');
    gameContainerEl.classList.add('hidden');
    findMatchBtn.disabled = false;
    findMatchBtn.textContent = 'Find Match';
    updateStatus('Ready to play', 'connected');
}

// Find match button
findMatchBtn.addEventListener('click', () => {
    socket.emit('findMatch', { gameType: 'connect4' });
});

// Initialize
initializeBoard();
updateStatus('Ready to play', 'connected');

