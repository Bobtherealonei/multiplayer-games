# Tic-Tac-Toe Multiplayer Game

A real-time multiplayer Tic-Tac-Toe game built with Node.js, Express, and Socket.IO.

## Features

- Real-time multiplayer gameplay
- Automatic matchmaking system
- Clean and modern UI
- Responsive design
- Game state synchronization

## Prerequisites

- Node.js (v14 or higher)
- npm (Node Package Manager)

## Installation

1. Navigate to the server directory:
```bash
cd server
```

2. Install dependencies:
```bash
npm install
```

## Running the Application

1. Start the server:
```bash
cd server
node index.js
```

The server will start on port 3000 (or the port specified in the PORT environment variable).

2. Open your browser and navigate to:
```
http://localhost:3000
```

3. Click "Find Match" to start searching for an opponent.

4. Once matched, you can start playing Tic-Tac-Toe!

## Project Structure

```
games/
├── server/
│   ├── index.js          # Main server file with Express and Socket.IO setup
│   ├── matchmaking.js    # Matchmaking logic for pairing players
│   ├── ticTacToe.js      # Tic-Tac-Toe game logic
│   └── gameManager.js    # Manages game instances and player connections
├── client/
│   ├── index.html        # Main HTML file
│   ├── style.css         # Styling for the game
│   └── ticTacToe.js      # Client-side game logic and Socket.IO handlers
└── README.md             # This file
```

## How It Works

1. **Matchmaking**: When a player clicks "Find Match", they are added to a queue. When two players are in the queue, they are automatically matched.

2. **Game Logic**: The server manages the game state, validates moves, and checks for winners or draws.

3. **Real-time Updates**: Using Socket.IO, game state is synchronized in real-time between both players.

4. **Game Flow**: 
   - Players take turns making moves
   - The game checks for a winner after each move
   - If no winner and board is full, it's a draw
   - Game ends automatically after 5 seconds of completion

## Technologies Used

- **Node.js**: Server-side runtime
- **Express**: Web framework
- **Socket.IO**: Real-time bidirectional communication
- **HTML/CSS/JavaScript**: Client-side implementation

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions on hosting this application online.

Quick options:
- **Railway** (Recommended): Easiest setup, free tier available
- **Render**: Free tier, automatic SSL
- **Heroku**: Paid hosting option
- **Vercel**: Good for static + API routes

## License

MIT

