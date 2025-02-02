const mongoose = require('mongoose');

// Function to generate an array of 75 unique random numbers
const generateRandomNumbers = () => {
  const numbers = [];
  while (numbers.length < 75) {
    const randomNumber = Math.floor(Math.random() * 75) + 1;
    if (!numbers.includes(randomNumber)) {
      numbers.push(randomNumber);
    }
  }
  return numbers;
};

// Function to generate random 4 digit number
const generateGameId = () => {
  return Math.floor(100000 + Math.random() * 900000);
};

const bingoGameSchema = new mongoose.Schema({
  gameId: {
    type: Number,
    unique: true
  },
  selectedCartela: [{
    type: Number
  }],
  playerCartelas: [{
    userId: String,
    debitTransactionId: String,
    cartela: Number
  }],
  stake: {
    type: Number, 
    default: 10,
    enum: [0, 5, 10, 20, 50, 100]
  },
  cutPercentage: {
    type: Number 
  },
  winAmount: {
    type: Number, 
  },
  profitAmount: {
    type: Number, 
  },
  randomNumbers: {
    type: [Number],
    default: generateRandomNumbers 
  }, 
  winnerCartela: {
    type: Number
  },
  winnerUser: {
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User'
  },
  winnerUsername: {
    type: String,
    default: null
  },
  gameStatus: {
    type: String,
    default: "waiting",
    enum: ["waiting", "started", "verifying", "finished"]
  }, 
  calledNumbers: { 
    type: [Number]
  },
  markedCardKey: {
    type: [String]
  }, 
  winningPatterns: {
    type: [String],
    default: ["n3"]
  },
  preBoughtCartelas: [{
    userId: String,
    debitTransactionId: String,
    cartela: Number
  }]
}, {
  timestamps: true
});

bingoGameSchema.pre('save', async function(next) {
  if (this.isNew) {
    let newGameId;
    let isUnique = false;
    
    // Keep trying until we get a unique gameId
    while (!isUnique) {
      newGameId = generateGameId();
      // Check if this gameId already exists
      const existingGame = await this.constructor.findOne({ gameId: newGameId });
      if (!existingGame) {
        isUnique = true;
      }
    }
    
    this.gameId = newGameId;
  }
  next();
});

const BingoGame = mongoose.model('BingoGame', bingoGameSchema);

module.exports = BingoGame;
