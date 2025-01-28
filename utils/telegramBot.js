require('dotenv').config();
const TelegramBot = require("node-telegram-bot-api");
const User = require("../models/userModel");
const path = require('path');
const transactionHandlers = require("./transactionHandler");
const historyHandlers = require("./historyHandler");
const DepositRequest = require('../models/depositRequestModel.js');

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
          [{ text: "Balance 💰", callback_data: "balance" }, { text: "Winners 🎉", callback_data: "gamesHistory" }, { text: "Transactions", callback_data: "history" }],
          [{ text: "Convert 💱", callback_data: "convert" }]
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
    await bot.sendMessage(chatId, `💰 Balance: ${Math.floor(user.balance)}`);
    await bot.sendMessage(chatId, `🎁 Bonus: ${Math.floor(user.bonus)}`);
  },

  // Transaction handlers
  deposit: async (chatId) => {
    try {
      const user = await User.findOne({ chatId });
      if (!user) {
        await bot.sendMessage(chatId, "❌ Please register first using /register");
        return;
      }

      // First send the tutorial GIF
      const tutorialGifPath = path.join(__dirname, 'tutorial.gif');
      await bot.sendAnimation(chatId, tutorialGifPath);

      const accountNumber = "1000186729785";
      
      await bot.sendMessage(chatId, 
        `🏦 Commercial Bank of Ethiopia Account Number:\n\`${accountNumber}\`\n\n` +
        "Deposit ለማድረግ የፈለጉትን ብር ወደዚህ የንግድባንክ አካውንት ብር ካስገቡ በኋላ https://.... ብሎ የሚጀምረዉን የትራንዛክሽን ቁጥር  ያስገቡት ",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [ 
              [{ text: "እዚ ላይ ያስገቡት 👇👇👇", callback_data: "submit_transaction" }]
            ]
          }
        }
      );

    } catch (error) {
      console.error("Deposit Error:", error);
      await bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
    }
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
  },

  // New convert handler
  convert: async (chatId) => {
    const session = await User.startSession();
    await session.startTransaction();

    try {
      const user = await User.findOne({ chatId }).session(session);
      if (!user) {
        await bot.sendMessage(chatId, "❌ User not found. Please register first.");
        await session.abortTransaction();
        return;
      }

      // Collect response with validation
      const collectResponse = async () => {
        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            bot.removeListener('message', messageHandler);
            reject(new Error('Conversion timeout'));
          }, 120000);

          const messageHandler = async (msg) => {
            if (msg.chat.id === chatId) {
              const amount = parseInt(msg.text);
              if (!isNaN(amount) && amount > 0 && amount <= user.bonus) {
                clearTimeout(timeout);
                bot.removeListener('message', messageHandler);
                resolve(amount);
              } else {
                await bot.sendMessage(chatId, `❌ Invalid amount. You have ${user.bonus} bonus points. Enter valid amount:`);
              }
            }
          };

          bot.on('message', messageHandler);
          await bot.sendMessage(chatId, `🎁 Your bonus points: ${user.bonus}\nEnter amount to convert (100 bonus = 10 birr):`);
        });
      };

      const amount = await collectResponse();
      const balanceToAdd = amount / 10;

      // Update user balance and bonus
      await User.updateOne(
        { chatId },
        {
          $inc: {
            balance: balanceToAdd,
            bonus: -amount
          }
        }
      ).session(session);

      await session.commitTransaction();
      await bot.sendMessage(chatId, `✅ Converted ${amount} bonus to ${balanceToAdd} balance!`);

    } catch (error) {
      await session.abortTransaction();
      const errorMessage = error.message === 'Conversion timeout'
        ? "⏰ Conversion timed out. Please try again"
        : "❌ Conversion failed. Please try /convert again";
      await bot.sendMessage(chatId, errorMessage);
      console.error("Conversion Error:", error);
    } finally {
      await session.endSession();
    }
  },

  sendBonusAnnouncement: async (chatId) => {
    try {
      // Security: Only allow admins to send announcements
      const adminUser = await User.findOne({ chatId, role: 1 });
      if (!adminUser) {
        await bot.sendMessage(chatId, "❌ Admin privileges required");
        return;
      }

      // Batch processing with rate limiting
      const users = await User.find({}, 'chatId bonus');
      const BATCH_SIZE = 10;
      const DELAY_MS = 1000;

      for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (user) => {
          try {
            await bot.sendMessage(
              user.chatId,
              `🎉 Your bonus points: ${Math.floor(user.bonus)}\n\n` +
              `Use /convert to turn bonuses into playable balance!` +
              `\n\n🎁 100 bonus points = 10 birr`
            );
          } catch (error) {
            console.error(`Failed to send to ${user.chatId}:`, error.message);
          }
        }));

        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
      await bot.sendMessage(chatId, `✅ Announcement sent to ${users.length} users`);
    } catch (error) {
      console.error('Announcement error:', error);
      await bot.sendMessage(chatId, "❌ Failed to send announcements");
    }
  },
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
  '/convert': safeCommandHandler(commandHandlers.convert, 'convert'),
  '/announce': safeCommandHandler(commandHandlers.sendBonusAnnouncement, 'announce'),
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
  convert: safeCommandHandler(commandHandlers.convert, 'convert'),
  submit_transaction: async (chatId) => {
    await bot.sendMessage(chatId, "📝 Please enter your CBE transaction ID:");
    await collectTransactionId(chatId);
  },
  copy_1000186729785: async (chatId, query) => {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: "Account number copied! 📋",
        show_alert: true
      });
    } catch (error) {
      console.error("Copy callback error:", error);
    }
  }
};

const collectTransactionId = async (chatId) => {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      bot.removeListener('message', messageHandler);
      bot.sendMessage(chatId, "⏰ Deposit request timed out. Please try again.");
      reject(new Error('Timeout'));
    }, 300000); // 5 minutes timeout

    const messageHandler = async (msg) => {
      if (msg.chat.id === chatId) {
        const transactionId = msg.text.trim();

        // Enhanced validation for transaction ID
        if (!transactionId.toLowerCase().startsWith('https')) {
          await bot.sendMessage(chatId, "❌ Invalid transaction ID. Transaction ID must start with 'https'. Please enter a valid one:");
          return;
        }

        // Basic length validation
        if (transactionId.length < 4) {
          await bot.sendMessage(chatId, "❌ Invalid transaction ID. Please enter a valid one:");
          return;
        }

        try {
          // Check if transaction ID already exists
          const existingRequest = await DepositRequest.findOne({ transactionId });
          if (existingRequest) {
            await bot.sendMessage(chatId, "❌ This transaction ID has already been submitted. Please enter a different one:");
            return;
          }

          // Save deposit request
          await DepositRequest.create({
            transactionId,
            chatId,
            bank: 'CBE'
          });

          clearTimeout(timeout);
          bot.removeListener('message', messageHandler);

          await bot.sendMessage(chatId,
            "✅ Your deposit is being processed" 
          );

          await Promise.all([
            bot.sendMessage(1982046925, `💰 Deposit request from @${chatId} for ${transactionId}`),
            bot.sendMessage(415285189, `💰 Deposit request from @${chatId} for ${transactionId}`),
            bot.sendMessage(923117728, `💰 Deposit request from @${chatId} for ${transactionId}`)
          ]);
          resolve();
        } catch (error) {
          console.error("Error saving deposit request:", error);
          await bot.sendMessage(chatId, "❌ Error saving deposit request. Please try again.");
          reject(error);
        }
      }
    };

    bot.on('message', messageHandler);
  });
};

// Improved callback query handler with error recovery
const handleCallbackQuery = async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    if (data.startsWith('copy_')) {
      const handler = callbackActions[data];
      if (handler) {
        await handler(chatId, callbackQuery);
      }
    } else {
      // Handle regular actions
      const handler = callbackActions[data];
      if (handler) {
        await handler(chatId);
      } else {
        console.log(`Unhandled callback data: ${data}`);
        await bot.sendMessage(chatId, "This action is currently not available. Please try again later.");
      }
    }
  } catch (error) {
    console.error('Callback query error:', error);
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
  if (userCache.has(chatId)) return userCache.get(chatId);
  const user = await User.findOne({ chatId }).lean().cache('1 minute');
  userCache.set(chatId, user);
  return user;
};

module.exports = bot; 