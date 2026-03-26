const Game = require('./game');

const TOPICS = {
  religion: {
    title: 'Religion',
    questions: [
      'Should religion play a role in government decisions?',
      'Is religion still as important today as it was in the past?',
      'Can you be a good person without religion?',
      'Should prayer be allowed in public schools?',
      'Does religion bring people together more than it divides them?',
      'Should parents raise their kids in one religion from birth?',
      'Is organized religion more helpful than harmful?',
      'Should religious beliefs ever excuse someone from following certain laws?',
      'Can science and religion fully coexist?',
      'Do religious values make society stronger?'
    ]
  },
  aiFuture: {
    title: 'AI and the Future',
    questions: [
      'Will AI create more jobs than it destroys?',
      'Is AI more helpful than dangerous?',
      'Should AI be heavily regulated by governments?',
      'Will AI make schoolwork too easy for students?',
      'Could AI become smarter than humans in a dangerous way?',
      'Should people be allowed to use AI for art and music?',
      'Will AI make human relationships weaker?',
      'Should companies have to tell you when you are talking to AI?',
      'Will AI improve daily life more than it harms privacy?',
      'Is society moving too fast with AI?'
    ]
  },
  currentPolitics: {
    title: 'Current Politics',
    questions: [
      'Is Trump a good president?',
      'Is Biden too old to be president?',
      'Is the U.S. government more divided than ever?',
      'Should age limits exist for presidents and members of Congress?',
      'Is the media fair in how it covers politics?',
      'Are protests an effective way to create political change?',
      'Has politics become too extreme in recent years?',
      'Should the government have more control over big companies?',
      'Do political parties cause more harm than good?',
      'Is the country headed in the right direction politically?'
    ]
  },
  collegeCareers: {
    title: 'College and Careers',
    questions: [
      'Is college worth the cost?',
      'Should trade school be pushed as much as college?',
      'Is it better to follow your passion or choose a high-paying career?',
      'Should students pick a career path earlier in life?',
      'Is networking more important than talent in getting a good job?',
      'Will college matter less in the future?',
      'Should internships always be paid?',
      'Is job stability more important than loving your work?',
      'Should success be measured more by money or happiness?',
      'Is starting your own business better than working for someone else?'
    ]
  },
  sportsDebate: {
    title: 'Sports',
    questions: [
      'Is LeBron better than Jordan?',
      'Is winning more important than sportsmanship?',
      'Should college athletes be paid more?',
      'Are referees and umpires too protected from criticism?',
      'Are athletes overpaid?',
      'Is team loyalty more important than going where you can win?',
      'Should performance-enhancing drug users be permanently banned?',
      'Are dynasties good for sports?',
      'Is football too dangerous to justify?',
      'Should trash talk be considered part of the game?'
    ]
  }
};

function randomQuestion(gameType) {
  const topic = TOPICS[gameType] || TOPICS.religion;
  const index = Math.floor(Math.random() * topic.questions.length);
  return {
    topicKey: gameType,
    topicTitle: topic.title,
    question: topic.questions[index]
  };
}

class TopicDebate extends Game {
  constructor() {
    super();
    this.playerSymbols = new Map();
    this.phase = 'debating';
    this.topicKey = 'religion';
    this.topicTitle = 'Religion';
    this.question = '';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('TopicDebate requires exactly 2 players');
    }

    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.phase = 'debating';
    const selected = randomQuestion(this.gameType);
    this.topicKey = selected.topicKey;
    this.topicTitle = selected.topicTitle;
    this.question = selected.question;
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
    this.createdAt = Date.now();

    return {
      success: true,
      player1: { id: players[0].id, symbol: 'P1' },
      player2: { id: players[1].id, symbol: 'P2' }
    };
  }

  makeMove(playerId, move) {
    const playerSymbol = this.playerSymbols.get(playerId);
    if (!playerSymbol) {
      return { success: false, error: 'Player not in this debate' };
    }

    if (move && typeof move.readyToMatch === 'boolean') {
      this.matchRequests[playerSymbol] = move.readyToMatch;
      if (this.matchRequests.P1 && this.matchRequests.P2) {
        this.phase = 'matched';
      } else {
        this.phase = 'debating';
      }
      return { success: true };
    }

    return { success: false, error: 'Invalid debate action' };
  }

  getState() {
    return {
      board: [[this.question]],
      currentPlayer: '',
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 1,
      cols: 1,
      phase: this.phase,
      topicKey: this.topicKey,
      topicTitle: this.topicTitle,
      question: this.question,
      matchRequests: { ...this.matchRequests }
    };
  }

  isFinished() {
    return false;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.phase = 'debating';
    this.question = '';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
  }
}

module.exports = TopicDebate;
