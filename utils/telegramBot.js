require('dotenv').config();
const TelegramBot = require("node-telegram-bot-api");
const User = require("../models/userModel");
const path = require('path');
const transactionHandlers = require("./transactionHandler");
const historyHandlers = require("./historyHandler"); 

const bot = new TelegramBot(process.env.TELEGRAMBOTTOKEN, { polling: true });
const baseUrl = process.env.CLIENT_URL

// Improved transaction lock mechanism with timeout and cleanup
const activeTransactions = new Map();
const LOCK_TIMEOUT = 60000; // 1 minute timeout
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  activeTransactions.forEach((expiry, key) => {
    if (now > expiry) activeTransactions.delete(key);
  });
}, 30000); // Reduced from 60s to 30s cleanup

const acquireLock = (chatId, operation) => {
  const key = `${chatId}-${operation}`;
  const now = Date.now();

  // Clean expired locks
  for (const [lockKey, expiry] of activeTransactions.entries()) {
    if (now > expiry) {
      activeTransactions.delete(lockKey);
    }
  }

  if (activeTransactions.has(key)) {
    return false;
  }

  activeTransactions.set(key, now + LOCK_TIMEOUT);
  return true;
};

const releaseLock = (chatId, operation) => {
  const key = `${chatId}-${operation}`;
  activeTransactions.delete(key);
};

// Improved safe command handler with proper error handling
const safeCommandHandler = (handler, operationName) => async (chatId, ...args) => {
  const operation = operationName || handler.name;

  if (!acquireLock(chatId, operation)) {
    await bot.sendMessage(chatId, "⚠️ Please wait for your previous operation to complete.");
    return;
  }

  try {
    await handler(chatId, ...args);
  } catch (error) {
    console.error(`Error in ${operation}:`, error);
    await bot.sendMessage(
      chatId,
      "❌ An error occurred. Please try again later."
    );
  } finally {
    releaseLock(chatId, operation);
  }
};

// Command handlers object to group related functions
const commandHandlers = {
  // Menu handling
  sendMainMenu: async (chatId) => {
    const imagePath = path.join(__dirname, 'menu.jpg');
    await bot.sendPhoto(chatId, imagePath, {
      caption: "Welcome to Joker Bingo! Choose an option below.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Play 🎮", web_app: { url: `${baseUrl}/room?token=${chatId}` } }, { text: "Register 👤", callback_data: "register" }, { text: "Join Group ", url: "https://t.me/jokerbingo_bot_group" }],
          [{ text: "Deposit 💸", callback_data: "deposit" }, { text: "Withdraw 💁‍♂️", callback_data: "withdraw" }, { text: "Transfer 💳", callback_data: "transfer" }],
          [{ text: "Balance 💰", callback_data: "balance" }, { text: "Winners 🎉", callback_data: "gamesHistory" }, { text: "Transactions", callback_data: "history" } ],


        ]
      }
    });
  },
 

  // Game related handlers
  play: async (chatId) => {
    try {
      // Check if user exists in database
      const user = await User.findOne({ chatId });

      if (!user) {
        return bot.sendMessage(
          chatId,
          "⚠️ Please register first /register to start playing."
        );
      }

      // If user exists, proceed with sending game options
      await bot.sendMessage(chatId, "🎮 Best of luck on your gaming adventure!", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Play 🎮", web_app: { url: `${baseUrl}/room?token=${chatId}` } }
            ]
          ]
        }
      });
    } catch (error) {
      console.error('Error in play handler:', error);
      await bot.sendMessage(
        chatId,
        "❌ Sorry, something went wrong. Please try again later."
      );
    }
  },

  // User account handlers
  register: async (chatId) => {
    const session = await User.startSession();
    await session.startTransaction();

    try {
        const existingUser = await User.findOne({ chatId }).session(session);
        if (existingUser) {
            await bot.sendMessage(chatId, "✅ You're already registered! Use /play to start.");
            await session.commitTransaction();
            return;
        }

        // Enhanced phone number validation with retry logic
        const validatePhoneNumber = (number) => {
            const ethiopianRegex = /^09[0-9]{8}$/;
            return ethiopianRegex.test(number);
        };

        // Modified collectResponse to return full message object
        const collectResponse = async (promptText, validationFn) => {
            return new Promise(async (resolve, reject) => {
                const timeout = setTimeout(() => {
                    bot.removeListener('message', messageHandler);
                    reject(new Error('Input timeout'));
                }, 120000);

                const messageHandler = async (msg) => {
                    if (msg.chat.id === chatId && validationFn(msg.text)) {
                        clearTimeout(timeout);
                        bot.removeListener('message', messageHandler);
                        resolve(msg); // Return full message object
                    } else if (msg.chat.id === chatId) {
                        await bot.sendMessage(chatId, "❌ Invalid format. Please try again:");
                    }
                };

                bot.on('message', messageHandler);
                await bot.sendMessage(chatId, promptText);
            });
        };

        // Get phone number message with user details
        const phoneNumberMessage = await collectResponse(
            "📱 Please enter your phone number (09xxxxxxxx):",
            validatePhoneNumber
        );
        
        // Extract values from collected message
        const phoneNumber = phoneNumberMessage.text;
        const username = phoneNumberMessage.from.username || 
                        `${phoneNumberMessage.from.first_name}_${phoneNumberMessage.from.id}`;

        // Check for existing phone number
        const phoneExists = await User.exists({ phoneNumber }).session(session);
        if (phoneExists) {
            await bot.sendMessage(chatId, "❌ This number is already registered");
            await session.abortTransaction();
            return;
        }

        // Create user with transaction
        await User.create([{
            chatId,
            phoneNumber,
            username, 
        }], { session });

        await session.commitTransaction();
        await bot.sendMessage(chatId, "🎉 Registration successful!\n\n" +
            "• Use /deposit to add funds\n" +
            "• Use /play to start games\n" +
            "• Check /balance anytime");

    } catch (error) {
        await session.abortTransaction();
        
        // Enhanced error messages
        const errorMessages = {
            'Input timeout': '⏰ Registration timed out. Please try again',
            'MongoError': '🔒 Database error. Contact support'
        };

        await bot.sendMessage(chatId, errorMessages[error.message] || 
            "❌ Registration failed. Please try /register again");
        
        console.error("Registration Error:", error);
    } finally {
        await session.endSession();
    }
  },

  checkBalance: async (chatId) => {
    const user = await User.findOne({ chatId });
    if (!user) {
      await bot.sendMessage(chatId, "User not found. Please register first.");
      return;
    }
    await bot.sendMessage(chatId, `Your current balance is: 💰 ${Math.floor(user.balance)}`);
  },

  // Transaction handlers
  deposit: async (chatId) => {
    await transactionHandlers.deposit(chatId, bot);
  },
  withdraw: async (chatId) => {
    await transactionHandlers.withdraw(chatId, bot);
  },
 
  transfer: async (chatId) => {
    await transactionHandlers.transfer(chatId, bot);
  },

  history: async (chatId) => {
    await historyHandlers.showHistory(chatId, bot);
  },

  gamesHistory: async (chatId) => {
    await historyHandlers.showGameHistory(chatId, bot);
  }
};

// Updated command mappings with proper error handling
const commandMappings = {
  '/start': safeCommandHandler(async (chatId) => {
    await commandHandlers.sendMainMenu(chatId);
  }, 'start'), 
  '/play': safeCommandHandler(commandHandlers.play, 'play'), 
  '/register': safeCommandHandler(commandHandlers.register, 'register'),
  '/balance': safeCommandHandler(commandHandlers.checkBalance, 'balance'),
  '/deposit': safeCommandHandler(commandHandlers.deposit, 'deposit'),
  '/withdraw': safeCommandHandler(commandHandlers.withdraw, 'withdraw'), 
  '/transfer': safeCommandHandler(commandHandlers.transfer, 'transfer'),
  '/history': safeCommandHandler(commandHandlers.history, 'history'),
  '/winners': safeCommandHandler(commandHandlers.gamesHistory, 'gamesHistory'), 
};

// Register command handlers
Object.entries(commandMappings).forEach(([command, handler]) => {
  if (command === '/start') {
    bot.onText(/\/start(.+)?/, (msg, match) => handler(msg.chat.id, match));
  } else {
    bot.onText(new RegExp(`^${command}$`), (msg) => handler(msg.chat.id));
  }
});

const callbackActions = {
  play: safeCommandHandler(commandHandlers.play, 'play'),
  register: safeCommandHandler(commandHandlers.register, 'register'),
  deposit: safeCommandHandler(commandHandlers.deposit, 'deposit'),
  balance: safeCommandHandler(commandHandlers.checkBalance, 'balance'),
  withdraw: safeCommandHandler(commandHandlers.withdraw, 'withdraw'), 
  transfer: safeCommandHandler(commandHandlers.transfer, 'transfer'),
  history: safeCommandHandler(commandHandlers.history, 'history'),
  gamesHistory: safeCommandHandler(commandHandlers.gamesHistory, 'gamesHistory'),  
};

// Improved callback query handler with error recovery
const handleCallbackQuery = async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    // Try to answer callback query first with a short timeout
    try {
      await bot.answerCallbackQuery(callbackQuery.id, { timeout: 1000 });
    } catch (error) { }
 

    // Handle regular actions
    const handler = callbackActions[data];
    if (handler) {
      await handler(chatId);
    } else {
      console.log(`Unhandled callback data: ${data}`);
      await bot.sendMessage(chatId, "This action is currently not available. Please try again later.");
    }

  } catch (error) {
    console.error('Callback query error:', error);
    
    // Don't let single user errors crash the entire bot
    try {
      await bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
    } catch (msgError) {
      console.error('Error sending error message:', msgError);
    }
  }
};

// Register callback query handler
bot.on('callback_query', handleCallbackQuery);

// Add error handler for the bot
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
  // Continue polling despite errors
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
  // Continue operation despite errors
});

// Cleanup interval for expired locks
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of activeTransactions.entries()) {
    if (now > expiry) {
      activeTransactions.delete(key);
    }
  }
}, 60000);

// Database Query Optimization (Add caching)
const userCache = new Map();
const getUser = async (chatId) => {
  if(userCache.has(chatId)) return userCache.get(chatId);
  const user = await User.findOne({ chatId }).lean().cache('1 minute');
  userCache.set(chatId, user);
  return user;
};

module.exports = bot; 