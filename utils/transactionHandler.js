const User = require("../models/userModel");
const Finance = require("../models/financeModel.js");
const SantimpaySdk = require("../lib/index.js");

// Add transaction lock mechanism
const activeTransactions = new Map();

const acquireLock = async (chatId, operation, timeout = 60000) => {
    const key = `${chatId}-${operation}`;
    if (activeTransactions.has(key)) {
        return false;
    }
    activeTransactions.set(key, Date.now() + timeout);
    return true;
};

const releaseLock = (chatId, operation) => {
    const key = `${chatId}-${operation}`;
    activeTransactions.delete(key);
};

// Clean expired locks periodically
setInterval(() => {
    const now = Date.now();
    activeTransactions.forEach((expiry, key) => {
        if (now > expiry) {
            activeTransactions.delete(key);
        }
    });
}, 60000);

const PRIVATE_KEY_IN_PEM = `
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIFamQMQ/56tZuX6sZQBzxxs4EbH9ndELv14JMo6fkfR0oAoGCCqGSM49
AwEHoUQDQgAE09zpUSJToy6M+FWWGQUatRLpUot2314yuBLEZ2XfDhNtEqsqpJ1a
bFpzTyPzIa0JE/MULNEx0rjnia3FntuoiA==
-----END EC PRIVATE KEY-----
`

const GATEWAY_MERCHANT_ID = process.env.GATEWAY_MERCHANT_ID;
const client = new SantimpaySdk(GATEWAY_MERCHANT_ID, PRIVATE_KEY_IN_PEM);
const notifyUrl = "https://jbackend-v2.onrender.com/api/callback/verify-transaction"; 

const getValidInput = async (bot, chatId, prompt, validator) => {
    while (true) {
        try {
            await bot.sendMessage(chatId, prompt);
            const response = await new Promise((resolve, reject) => {
                const messageHandler = (msg) => {
                    if (msg.chat.id === chatId) {
                        // Check if message is a command (starts with '/')
                        if (msg.text.startsWith('/')) {
                            bot.removeListener('message', messageHandler);
                            reject(new Error('Command interrupt'));
                            return;
                        }
                        bot.removeListener('message', messageHandler);
                        resolve(msg);
                    }
                };
                bot.on('message', messageHandler);
                setTimeout(() => {
                    bot.removeListener('message', messageHandler);
                    reject(new Error('Response timeout'));
                }, 60000);
            });

            if (validator(response.text)) {
                return response.text;
            } else {
                await bot.sendMessage(chatId, "Invalid input. Please try again.");
            }
        } catch (error) {
            if (error.message === 'Command interrupt') {
                // Exit silently if interrupted by a command
                return null;
            }
            console.error('Error getting input:', error);
            await bot.sendMessage(chatId, "Operation cancelled.");
            return null;
        }
    }
};


const transactionHandlers = {
    deposit: async (chatId, bot) => {
        if (!await acquireLock(chatId, 'deposit')) {
            await bot.sendMessage(chatId, "⚠️ A deposit is already in progress. Please wait.");
            return;
        }

        try {
            const user = await User.findOne({ chatId });
            if (!user) {
                await bot.sendMessage(chatId, "❌ Please register first to make a deposit.");
                return;
            }

            // Add Telebirr button first
            const paymentMethodMsg = await bot.sendMessage(chatId, "Select payment method:", {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "Telebirr 📱", callback_data: "telebirr_deposit" }
                    ]]
                }
            });

            // Wait for button click
            try {
                await new Promise((resolve, reject) => {
                    const callbackHandler = (callbackQuery) => {
                        if (callbackQuery.message.chat.id === chatId &&
                            callbackQuery.data === "telebirr_deposit") {
                            bot.removeListener('callback_query', callbackHandler);
                            resolve();
                        }
                    };
                    bot.on('callback_query', callbackHandler);
                    setTimeout(() => reject(new Error('Timeout')), 60000);
                });
            } catch (error) {
                await bot.sendMessage(chatId, "⏰ Deposit cancelled due to timeout.");
                return;
            }

            // Rest of the deposit logic
            let amount = await getValidInput(
                bot,
                chatId,
                "💰 Enter amount to deposit (10 ETB - 1000 ETB):",
                (text) => {
                    const num = parseFloat(text);
                    return !isNaN(num) && num >= 10 && num <= 1000;
                }
            );

            // Exit if input was interrupted
            if (!amount) {
                return;
            }

            const first_name = user.username;
            const phoneNumber = user.phoneNumber.replace(/^0/, '+251');

            const paymentMethod = "Telebirr";

            if (!first_name || !phoneNumber) {
                await bot.sendMessage(chatId, "Please set a username and phone number in your Telegram settings and try again.");
                return;
            }

            // custom ID used by merchant to identify the payment
            const id = Math.floor(Math.random() * 1000000000).toString();


            try {
                const response = await client.directPayment(id, amount, "Ticket Purchase For JokerBingoBot", notifyUrl, phoneNumber, paymentMethod);
                const transaction = await client.checkTransactionStatus(id);

                await new Finance({
                    transactionId: id,
                    chatId: chatId,
                    amount: amount,
                    status: "PENDING_APPROVAL",
                    type: 'deposit',
                    santimPayTxnId: transaction.santimPayTxnId,
                    paymentMethod
                }).save();

                await bot.sendMessage(chatId, "Deposit Processing Please Wait");
            } catch (error) {
                console.error("Payment processing error:", error);
                await bot.sendMessage(chatId, "❌ Payment processing failed. Please try again.");
            }

        } catch (error) {
            console.error("Deposit Error:", error);
            await bot.sendMessage(chatId, "❌ An unexpected error occurred. Please try again later.");
        } finally {
            releaseLock(chatId, 'deposit');
        }
    },

    withdraw: async (chatId, bot) => {
        if (!await acquireLock(chatId, 'withdraw')) {
            await bot.sendMessage(chatId, "⚠️ A withdrawal is already in progress. Please wait.");
            return;
        }

        try {
            const user = await User.findOne({ chatId });
            if (!user) {
                await bot.sendMessage(chatId, "❌ Please register first to withdraw funds.");
                return;
            }

            // Rest of the withdraw logic
            let amount = await getValidInput(
                bot,
                chatId,
                "💰 Enter amount to withdraw (50 ETB - 200 ETB):",
                (text) => {
                    const num = parseFloat(text);
                    return !isNaN(num) && num >= 50 && num <= 200;
                }
            );

            if (!amount) return;

            // Add balance check
            if (user.balance < parseFloat(amount)) {
                await bot.sendMessage(chatId, "❌ Insufficient balance for withdrawal.");
                return;
            }

            const first_name = user.username;
            const phoneNumber = user.phoneNumber.replace(/^0/, '+251');

            if (!first_name || !phoneNumber) {
                await bot.sendMessage(chatId, "Please set a username and phone number in your Telegram settings and try again.");
                return;
            }

            // Create transaction record first
            const id = Math.floor(Math.random() * 1000000000).toString();
            const transactionNew = new Finance({
                transactionId: id,
                chatId: chatId,
                amount: amount,
                status: "PENDING_APPROVAL",
                type: 'withdrawal',
                paymentMethod: "Telebirr"
            });

            // Update user balance
            user.balance -= parseFloat(amount);
            
            // Save both transaction and user update
            await Promise.all([
                transactionNew.save(),
                user.save()
            ]);

            await bot.sendMessage(chatId, "✅ Withdrawal request submitted successfully! Please wait for admin approval.");

            // Notify admins
            const adminMessage = `✅ Withdrawal request from @${user.username || chatId} for ${amount} ETB`;
            await Promise.all([
                bot.sendMessage(1982046925, adminMessage),
                bot.sendMessage(415285189, adminMessage),
                bot.sendMessage(923117728, adminMessage)
            ]);

        } catch (error) {
            console.error("Withdrawal Error:", error);
            await bot.sendMessage(chatId, "❌ An error occurred during withdrawal. Please try again later.");
        } finally {
            releaseLock(chatId, 'withdraw');
        }
    },

    transfer: async (chatId, bot) => {
        if (!await acquireLock(chatId, 'transfer')) {
            await bot.sendMessage(chatId, "⚠️ A transfer is already in progress. Please wait.");
            return;
        }

        const session = await User.startSession();
        session.startTransaction();

        try {
            const sender = await User.findOne({ chatId }).session(session);
            if (!sender) {
                await bot.sendMessage(chatId, "Please register first to transfer funds.");
                return;
            }

            const amount = await getValidInput(
                bot,
                chatId,
                "Enter amount to transfer (30 ETB - 10000 ETB):",
                (text) => {
                    const num = parseFloat(text);
                    return !isNaN(num) && num >= 30 && num <= 10000;
                }
            );

            // Check if sender has sufficient balance
            if (sender.balance < parseFloat(amount)) {
                await bot.sendMessage(chatId, "Insufficient balance for this transfer.");
                return;
            }

            const recipientPhone = await getValidInput(
                bot,
                chatId,
                "Enter recipient's phone number (format: 09xxxxxxxx):",
                (text) => /^09\d{8}$/.test(text)
            );

            // Find recipient by phone number
            const recipient = await User.findOne({ phoneNumber: recipientPhone }).session(session);
            if (!recipient) {
                await bot.sendMessage(chatId, "Recipient not found. Please check the phone number and try again.");
                return;
            }

            // Prevent self-transfer
            if (recipient.chatId === chatId) {
                await bot.sendMessage(chatId, "You cannot transfer to yourself.");
                return;
            }

            // Atomic transfer operation
            sender.balance -= parseFloat(amount);
            recipient.balance += parseFloat(amount);

            await sender.save({ session });
            await recipient.save({ session });

            const transactionId = `TR${Date.now()}${Math.random().toString(36).substr(2, 4)}`;

            await new Finance({
                transactionId,
                chatId,
                recipientChatId: recipient.chatId,
                amount: parseFloat(amount),
                status: 'COMPLETED',
                type: 'transfer'
            }).save({ session });

            await session.commitTransaction();

            // Notify both parties
            await Promise.all([
                bot.sendMessage(chatId, `Transfer successful!\nAmount: ${amount} ETB\nTo: ${recipientPhone}\nTransaction ID: ${transactionId}`),
                bot.sendMessage(recipient.chatId, `You received ${amount} ETB from ${sender.phoneNumber}\nTransaction ID: ${transactionId}`)
            ]);

        } catch (error) {
            await session.abortTransaction();
            console.error("Transfer Error:", error);
            await bot.sendMessage(chatId, "Error processing transfer. Please try again. /transfer");
        } finally {
            session.endSession();
            releaseLock(chatId, 'transfer');
        }
    },

};

module.exports = transactionHandlers; 
