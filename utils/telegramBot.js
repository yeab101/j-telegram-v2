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
          [{ text: "Convert Bonus 💱", callback_data: "convert" }, { text: "My Profile 👤", callback_data: "myprofile" }]
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

      const tutorialGifPath = path.join(__dirname, 'tutorial.gif');
      await bot.sendAnimation(chatId, tutorialGifPath);

      await bot.sendMessage(chatId, 
        "🏦 Choose your deposit method:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "CBE", callback_data: "deposit_cbe" },
                { text: "Telebirr", callback_data: "deposit_telebirr" }
              ]
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
      // Admin verification
      const adminUser = await User.findOne({ chatId, role: 1 });
      if (!adminUser) {
        await bot.sendMessage(chatId, "❌ Admin privileges required");
        return;
      }

      // Collect announcement message
      const collectMessage = () => {
        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            bot.removeListener('message', messageHandler);
            reject(new Error('Message input timeout'));
          }, 300000); // 5 minutes timeout

          const messageHandler = async (msg) => {
            if (msg.chat.id === chatId) {
              if (msg.text === '/cancel') {
                clearTimeout(timeout);
                bot.removeListener('message', messageHandler);
                reject(new Error('Cancelled by user'));
                return;
              }

              clearTimeout(timeout);
              bot.removeListener('message', messageHandler);
              resolve(msg.text);
            }
          };

          bot.on('message', messageHandler);
          await bot.sendMessage(chatId, 
            "📢 Enter your announcement message (or /cancel to abort):\n" +
            "Max 400 characters", {
            reply_markup: { force_reply: true }
          });
        });
      };

      // Get message from admin
      const announcementText = (await collectMessage()).slice(0, 400);
      
      // Confirmation step
      await bot.sendMessage(chatId, `⚠️ Confirm send this to all users?:\n\n${announcementText}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Send", callback_data: "confirm_announce" }],
            [{ text: "❌ Cancel", callback_data: "cancel_announce" }]
          ]
        }
      });

      // Store pending announcement in admin user object
      await User.findByIdAndUpdate(adminUser._id, {
        pendingAnnouncement: announcementText
      });

    } catch (error) {
      const errorMessage = error.message === 'Message input timeout' 
        ? "⏰ Announcement creation timed out"
        : error.message === 'Cancelled by user'
        ? "❌ Announcement cancelled"
        : "❌ Announcement failed";
      await bot.sendMessage(chatId, errorMessage);
    }
  },

  // Updated profile handler
  showMyProfile: async (chatId) => {
    try {
      const user = await User.findOne({ chatId });
      if (!user) {
        await bot.sendMessage(chatId, "❌ User not found. Please register first.");
        return;
      }

      const profileMessage = `👤 Your Profile:\n\n` +
        `🆔 ID : ${user.chatId}\n` +
        `📱 Phone : ${user.phoneNumber}\n` +
        `👤 Username: @${user.username}`;

      await bot.sendMessage(chatId, profileMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✏️ Change Username", callback_data: "change_username" },
              { text: "📱 Change Phone", callback_data: "change_phonenumber" }
            ]
          ]
        }
      });
    } catch (error) {
      console.error('Profile Error:', error);
      await bot.sendMessage(chatId, "❌ Failed to retrieve profile");
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
  '/myprofile': safeCommandHandler(commandHandlers.showMyProfile, 'myprofile'),
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
  deposit_cbe: async (chatId) => {
    const accountNumber = "1000186729785";
    await bot.sendMessage(chatId,
      `🏦 CBE Account:\n\`${accountNumber}\`\n\n` +
      "After transfer, click below to submit transaction ID:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Submit CBE Transaction", callback_data: "submit_cbe_transaction" }]
          ]
        }
      }
    );
  },
  
  deposit_telebirr: async (chatId) => {
    const accountNumber = "0967813965";
    const cbeAccountNumber = "1000186729785";
    await bot.sendMessage(chatId,
      `📱Telebirr Account:\n\`${accountNumber}\`\n\n` +
      `OR 📱From Telebirr to this CBE Account:\n\`${cbeAccountNumber}\`\n\n` +
      "After transfer, click below to submit transaction ID:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Submit Telebirr Transaction", callback_data: "submit_telebirr_transaction" }]
          ]
        }
      }
    );
  },

  submit_cbe_transaction: async (chatId) => {
    await bot.sendMessage(chatId, "📝 Enter CBE transaction ID (starts with https):");
    await collectTransactionId(chatId, 'CBE');
  },

  submit_telebirr_transaction: async (chatId) => {
    await bot.sendMessage(chatId, "📝 Enter Telebirr transaction ID:");
    await collectTransactionId(chatId, 'Telebirr');
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
  },
  myprofile: safeCommandHandler(commandHandlers.showMyProfile, 'myprofile'),
  change_username: safeCommandHandler(async (chatId) => {
    const session = await User.startSession();
    await session.startTransaction();
    
    try {
      const collectResponse = async () => {
        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            bot.removeListener('message', messageHandler);
            reject(new Error('Username change timeout'));
          }, 120000);

          const messageHandler = async (msg) => {
            if (msg.chat.id === chatId) {
              const newUsername = msg.text.trim();
              
              if (newUsername.length < 3 || newUsername.length > 20) {
                await bot.sendMessage(chatId, 
                  "❌ Username must be 3-20 characters. Try again:");
                return;
              }

              const existingUser = await User.findOne({ username: newUsername }).session(session);
              if (existingUser) {
                await bot.sendMessage(chatId, 
                  "❌ Username already taken. Try another one:");
                return;
              }

              clearTimeout(timeout);
              bot.removeListener('message', messageHandler);
              resolve(newUsername);
            }
          };

          bot.on('message', messageHandler);
          await bot.sendMessage(chatId, 
            "Enter new username (3-20 characters):");
        });
      };

      const newUsername = await collectResponse();
      await User.updateOne({ chatId }, { username: newUsername }).session(session);
      await session.commitTransaction();
      
      await bot.sendMessage(chatId, "✅ Username updated successfully!");
      commandHandlers.showMyProfile(chatId);

    } catch (error) {
      await session.abortTransaction();
      await bot.sendMessage(chatId, error.message === 'Username change timeout' 
        ? "⏰ Username change timed out" 
        : "❌ Username update failed");
    } finally {
      await session.endSession();
    }
  }, 'change_username'),
  
  change_phonenumber: safeCommandHandler(async (chatId) => {
    const session = await User.startSession();
    await session.startTransaction();
    
    try {
      const validatePhoneNumber = (number) => /^09[0-9]{8}$/.test(number);
      
      const collectResponse = async () => {
        return new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            bot.removeListener('message', messageHandler);
            reject(new Error('Phone change timeout'));
          }, 120000);

          const messageHandler = async (msg) => {
            if (msg.chat.id === chatId) {
              if (!validatePhoneNumber(msg.text)) {
                await bot.sendMessage(chatId, 
                  "❌ Invalid format. Must start with 09 and 10 digits. Try again:");
                return;
              }

              const existingUser = await User.findOne({ 
                phoneNumber: msg.text 
              }).session(session);
              
              if (existingUser) {
                await bot.sendMessage(chatId, 
                  "❌ Phone number already registered. Try another one:");
                return;
              }

              clearTimeout(timeout);
              bot.removeListener('message', messageHandler);
              resolve(msg.text);
            }
          };

          bot.on('message', messageHandler);
          await bot.sendMessage(chatId, 
            "Enter new phone number (09xxxxxxxx):");
        });
      };

      const newPhone = await collectResponse();
      await User.updateOne({ chatId }, { phoneNumber: newPhone }).session(session);
      await session.commitTransaction();
      
      await bot.sendMessage(chatId, "✅ Phone number updated successfully!");
      commandHandlers.showMyProfile(chatId);

    } catch (error) {
      await session.abortTransaction();
      await bot.sendMessage(chatId, error.message === 'Phone change timeout' 
        ? "⏰ Phone change timed out" 
        : "❌ Phone number update failed");
    } finally {
      await session.endSession();
    }
  }, 'change_phonenumber'),
  confirm_announce: async (chatId) => {
    const adminUser = await User.findOne({ chatId, role: 1 });
    if (!adminUser?.pendingAnnouncement) return;

    try {
      const users = await User.find({}, 'chatId').lean();
      const BATCH_SIZE = 20;
      const DELAY_MS = 2000;
      let successCount = 0;

      for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);
        
        const results = await Promise.allSettled(batch.map(async (user) => {
          try {
            await bot.sendMessage(user.chatId, adminUser.pendingAnnouncement);
            return true;
          } catch (error) {
            console.error(`Failed to send to ${user.chatId}: ${error.message}`);
            return false;
          }
        }));

        successCount += results.filter(r => r.status === 'fulfilled' && r.value).length;
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }

      await bot.sendMessage(chatId, `📢 Announcement sent to ${successCount}/${users.length} users`);
      
    } catch (error) {
      console.error('Broadcast error:', error);
      await bot.sendMessage(chatId, "❌ Error sending announcements");
    } finally {
      await User.findByIdAndUpdate(adminUser._id, { $unset: { pendingAnnouncement: 1 } });
    }
  },

  cancel_announce: async (chatId) => {
    await User.updateOne({ chatId }, { $unset: { pendingAnnouncement: 1 } });
    await bot.sendMessage(chatId, "❌ Announcement cancelled");
  },

  confirm_transfer: async (chatId) => {
    // This will be handled within the transfer flow's Promise resolution
    return true;
  },

  cancel_transfer: async (chatId) => {
    // This will abort the transaction in the transfer handler
    return false;
  },

  withdraw_cbe: async (chatId) => true,
  withdraw_telebirr: async (chatId) => true,
  withdraw_cbebirr: async (chatId) => true,
};

const collectTransactionId = async (chatId, bankType) => {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      bot.removeListener('message', messageHandler);
      bot.sendMessage(chatId, "⏰ Deposit request timed out. Please try again.");
      reject(new Error('Timeout'));
    }, 300000); // 5 minutes timeout

    const messageHandler = async (msg) => {
      if (msg.chat.id === chatId) {
        const transactionId = msg.text.trim();



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
            bank: bankType
          });

          clearTimeout(timeout);
          bot.removeListener('message', messageHandler);

          await bot.sendMessage(chatId,
            "✅ Your deposit is being processed" 
          );

          await Promise.all([
            bot.sendMessage(1982046925, `💰 New ${bankType} deposit from @${chatId}: ${transactionId}`),
            bot.sendMessage(415285189, `💰 New ${bankType} deposit from @${chatId}: ${transactionId}`),
            bot.sendMessage(923117728, `💰 New ${bankType} deposit from @${chatId}: ${transactionId}`)
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