const socket = io();

let currentSymbol = null;
let gameState = null;
let board = null;

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
    for (let i = 0; i < 9; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.index = i;
        cell.addEventListener('click', () => handleCellClick(i));
        boardEl.appendChild(cell);
    }
}

// Handle cell click
function handleCellClick(position) {
    if (!gameState || gameState.winner || gameState.isDraw) {
        return;
    }

    if (gameState.currentPlayer !== currentSymbol) {
        return;
    }

    const cell = boardEl.children[position];
    if (cell.textContent !== '') {
        return;
    }

    socket.emit('makeMove', { position });
}

// Update board display
function updateBoard() {
    if (!gameState) return;

    for (let i = 0; i < 9; i++) {
        const cell = boardEl.children[i];
        const value = gameState.board[i];
        
        cell.textContent = value || '';
        cell.className = 'cell';
        
        if (value === 'X') {
            cell.classList.add('x');
        } else if (value === 'O') {
            cell.classList.add('o');
        }

        // Disable cells if game is over or not player's turn
        if (gameState.winner || gameState.isDraw || gameState.currentPlayer !== currentSymbol) {
            cell.classList.add('disabled');
        } else {
            cell.classList.remove('disabled');
        }
    }
}

// Update game info
function updateGameInfo() {
    if (!gameState) return;

    playerInfoEl.textContent = `You are playing as: ${currentSymbol}`;
    
    if (gameState.winner) {
        if (gameState.winner === currentSymbol) {
            turnInfoEl.textContent = 'You Win!';
            gameResultEl.textContent = 'Congratulations! You won!';
            gameResultEl.className = 'game-result win';
        } else {
            turnInfoEl.textContent = 'You Lose!';
            gameResultEl.textContent = 'Game Over! You lost.';
            gameResultEl.className = 'game-result lose';
        }
    } else if (gameState.isDraw) {
        turnInfoEl.textContent = 'Draw!';
        gameResultEl.textContent = 'It\'s a draw!';
        gameResultEl.className = 'game-result draw';
    } else {
        if (gameState.currentPlayer === currentSymbol) {
            turnInfoEl.textContent = 'Your Turn';
        } else {
            turnInfoEl.textContent = 'Opponent\'s Turn';
        }
        gameResultEl.textContent = '';
        gameResultEl.className = '';
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
    initializeBoard();
});

socket.on('gameState', (state) => {
    gameState = state;
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
    socket.emit('findMatch', { gameType: 'ticTacToe' });
});

// Initialize
initializeBoard();
updateStatus('Ready to play', 'connected');

