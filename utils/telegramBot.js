require('dotenv').config();
const TelegramBot = require("node-telegram-bot-api");
const User = require("../models/userModel");
const path = require('path');
const transactionHandlers = require("./transactionHandler");
const historyHandlers = require("./historyHandler");
const adminHandler = require("./adminHandler");

const bot = new TelegramBot(process.env.TELEGRAMBOTTOKEN, { polling: true });
const baseUrl = process.env.CLIENT_URL

// Improved transaction lock mechanism with timeout and cleanup
const activeTransactions = new Map();
const LOCK_TIMEOUT = 60000; // 1 minute timeout

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
          [{ text: "Play 🎮", web_app: { url: `${baseUrl}/room?token=${chatId}` } }, { text: "Register 👤", callback_data: "register" }],
          [{ text: "Deposit 💸", callback_data: "deposit" }, { text: "Withdraw 💁‍♂️", callback_data: "withdraw" }, { text: "Transfer 💳", callback_data: "transfer" }],
          [{ text: "Balance 💰", callback_data: "balance" }, { text: "Winners 🎉", callback_data: "gamesHistory" }, { text: "Transactions 📜", callback_data: "history" } ],
          [{ text: "Join Group ", url: "https://t.me/jokerbingo_bot_group" }, { text: "Invite Friends 🎁", callback_data: "getRefLink" }],
 
        ]
      }
    });
  },

  checkAdminStatus: async (chatId) => {
    await adminHandler.checkAdminStatus(chatId, bot);
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
    session.startTransaction();

    try {
      const existingUser = await User.findOne({ chatId }).session(session);
      if (existingUser) {
        await bot.sendMessage(chatId, "You are already registered! Use /play to start playing.");
        if (global.pendingReferrals?.[chatId]) {
          delete global.pendingReferrals[chatId];
        }
        return;
      }

      await bot.sendMessage(chatId, "Please enter your phone number (starting with '09'):");
      bot.once('message', async (msg) => {
        const phoneNumber = msg.text;
        const phoneRegex = /^09\d{8}$/;

        if (!phoneRegex.test(phoneNumber)) {
          await bot.sendMessage(chatId, "Ensure phone number is 10 digits and starts with '09xxxxxxxx'.");
          return;
        }

        const username = msg.from.username;
        if (!username) {
          await bot.sendMessage(chatId, "Username is required. Please set a username in your Telegram settings and try again.");
          return;
        }

        try {
          // Check for pending referral
          if (global.pendingReferrals && global.pendingReferrals[chatId]) {
            const inviterChatId = global.pendingReferrals[chatId];

            // Verify inviter exists and is not the same as new user
            if (inviterChatId === chatId) {
              delete global.pendingReferrals[chatId];
              await bot.sendMessage(chatId, "Self-referral is not allowed.");
              return;
            }

            const inviter = await User.findOne({ chatId: inviterChatId }).session(session);
            if (inviter) {
              // Create new user with referral info
              const user = new User({
                chatId: chatId,
                phoneNumber: phoneNumber,
                username: username,
                referredBy: inviterChatId
              });
              await user.save();

              // // Update inviter's stats and balance
              inviter.referralCount += 1;
              inviter.balance += 10;
              await inviter.save();

              // Notify inviter
              await bot.sendMessage(inviterChatId,
                `🎉 Congratulations! You received 10 birr bonus balance for inviting a new user!`
              );
            }

            // Clean up the pending referral
            delete global.pendingReferrals[chatId];
          } else {
            // Regular registration without referral
            const user = new User({
              chatId: chatId,
              phoneNumber: phoneNumber,
              username: username
            });
            await user.save();
          }

          await bot.sendMessage(chatId, "You are now registered! /deposit or /play");
        } catch (error) {
          console.error("Error handling registration:", error);
          bot.sendMessage(chatId, "There was an error processing your registration. Please try again.");
        }
      });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
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
    await safeCommandHandler(async () => {
      await transactionHandlers.deposit(chatId, bot);
    })(chatId);
  },
  withdraw: async (chatId) => {
    await safeCommandHandler(async () => {
      await transactionHandlers.withdraw(chatId, bot);
    })(chatId);
  },
 

  transfer: async (chatId) => {
    await safeCommandHandler(async () => {
      await transactionHandlers.transfer(chatId, bot);
    })(chatId);
  },

  history: async (chatId) => {
    await historyHandlers.showHistory(chatId, bot);
  },

  gamesHistory: async (chatId) => {
    await historyHandlers.showGameHistory(chatId, bot);
  },

  getRefLink: async (chatId) => {
    await bot.sendMessage(chatId,
      `Share this link to invite friends:\nhttps://t.me/JokerBingoBot?start=${chatId}`
    );
  },

  showFriends: async (chatId) => {
    try {
      const user = await User.findOne({ chatId });
      if (!user) {
        return bot.sendMessage(chatId, "Please register first!");
      }

      let message = `👥 *My Referrals*\n\n`;
      message += `Total Friends Invited: ${user.referralCount}\n`;
      message += `Total Bonus Earned: ${user.referralCount * 10} Birr\n\n`;
      message += `Share your referral link to start earning bonuses!`;

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Get Referral Link 🔗", callback_data: "getRefLink" }]
          ]
        }
      });
    } catch (error) {
      console.error("Error showing friends:", error);
      await bot.sendMessage(chatId, "Error fetching friends list. Please try again.");
    }
  },

};

// Updated command mappings with proper error handling
const commandMappings = {
  '/start': safeCommandHandler(async (chatId, match) => {
    const referralParam = match?.[1]?.trim();
    if (referralParam) {
      const inviterChatId = parseInt(referralParam);
      global.pendingReferrals = global.pendingReferrals || {};
      global.pendingReferrals[chatId] = inviterChatId;
    }
    await commandHandlers.sendMainMenu(chatId);
  }, 'start'),
  // aa
  '/play': safeCommandHandler(commandHandlers.play, 'play'), 
  '/register': safeCommandHandler(commandHandlers.register, 'register'),
  '/balance': safeCommandHandler(commandHandlers.checkBalance, 'balance'),
  '/deposit': safeCommandHandler(commandHandlers.deposit, 'deposit'),
  '/withdraw': safeCommandHandler(commandHandlers.withdraw, 'withdraw'), 
  '/transfer': safeCommandHandler(commandHandlers.transfer, 'transfer'),
  '/history': safeCommandHandler(commandHandlers.history, 'history'),
  '/winners': safeCommandHandler(commandHandlers.gamesHistory, 'gamesHistory'),
  '/reflink': safeCommandHandler(commandHandlers.getRefLink, 'getRefLink'),
  '/friends': safeCommandHandler(commandHandlers.showFriends, 'showFriends'),
  '/admin': safeCommandHandler(commandHandlers.checkAdminStatus, 'admin')
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
  balance: safeCommandHandler(commandHandlers.checkBalance, 'balance'),
  deposit: safeCommandHandler(commandHandlers.deposit, 'deposit'),
  withdraw: safeCommandHandler(commandHandlers.withdraw, 'withdraw'), 
  transfer: safeCommandHandler(commandHandlers.transfer, 'transfer'),
  history: safeCommandHandler(commandHandlers.history, 'history'),
  gamesHistory: safeCommandHandler(commandHandlers.gamesHistory, 'gamesHistory'),
  getRefLink: safeCommandHandler(commandHandlers.getRefLink, 'getRefLink'),
  showFriends: safeCommandHandler(commandHandlers.showFriends, 'showFriends'),

  // Add admin callback handlers 
  admin_settings: adminHandler.handleGameSettings,
  admin_menu: adminHandler.checkAdminStatus,

  // Settings submenu callbacks
  settings_cut: adminHandler.handleCutSettings,
  // Admin actions
  admin_search: (chatId) => adminHandler.handleUserSearch(chatId, bot),
  admin_block: (chatId) => adminHandler.handleUserBlock(chatId, bot),
  admin_announce: (chatId) => adminHandler.handleAnnouncement(chatId, bot),
  settings_cut: (chatId) => adminHandler.handleCutSettings(chatId, bot)

};

// Improved callback query handler
const handleCallbackQuery = async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    // Handle approval/rejection actions
    if (data.startsWith('approve_') || data.startsWith('reject_')) {
      const [action, ...params] = data.split('_');
      const handler = callbackActions[`${action}_withdrawal`];
      if (handler) {
        await handler(chatId, params.join('_'));
      }
      return;
    }
    // Handle regular actions
    const handler = callbackActions[data];
    if (handler) {
      await handler(chatId, bot);
    } else {
      console.log(`Unhandled callback data: ${data}`);
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Callback query error:', error);
    await bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "Operation failed. Please try again.",
      show_alert: true
    });
  }
};

// Register callback query handler
bot.on('callback_query', handleCallbackQuery);

// Cleanup interval for expired locks
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of activeTransactions.entries()) {
    if (now > expiry) {
      activeTransactions.delete(key);
    }
  }
}, 60000);

module.exports = bot; 