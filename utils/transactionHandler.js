const User = require("../models/userModel");
const Finance = require("../models/financeModel.js");
const SantimpaySdk = require("../lib/index.js");

// // Santim Test
// const PRIVATE_KEY_IN_PEM = `
// -----BEGIN EC PRIVATE KEY-----
// MHcCAQEEIF1FiolOiNt9VZga7Xv2Hnc9ogec+n17oAC7vtls3fBuoAoGCCqGSM49
// AwEHoUQDQgAEEcfE9DYOz/pkenjJ4Abdgr2BsYB5zhh+3RxlHA+ZDlQ63+RTJS2B
// A2vqUeASic2BPMd+LqrAlo+5nCLqdBm//g==
// -----END EC PRIVATE KEY-----
// `

// const GATEWAY_MERCHANT_ID = "9e2dab64-e2bb-4837-9b85-d855dd878d2b"


const PRIVATE_KEY_IN_PEM = `
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIFamQMQ/56tZuX6sZQBzxxs4EbH9ndELv14JMo6fkfR0oAoGCCqGSM49
AwEHoUQDQgAE09zpUSJToy6M+FWWGQUatRLpUot2314yuBLEZ2XfDhNtEqsqpJ1a
bFpzTyPzIa0JE/MULNEx0rjnia3FntuoiA==
-----END EC PRIVATE KEY-----
`

const GATEWAY_MERCHANT_ID = "27dcd443-1e6f-46d0-8cc3-5918b333dc2b";


const client = new SantimpaySdk(GATEWAY_MERCHANT_ID, PRIVATE_KEY_IN_PEM);
const notifyUrl = "https://jbackend-v2.onrender.com/api/callback/verify-transaction/withdraw";

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
    withdraw: async (chatId, bot) => {
        const session = await User.startSession();
        try {
            session.startTransaction();
            const user = await User.findOne({ chatId }).session(session);
            if (!user) {
                await bot.sendMessage(chatId, "❌ Please register first to withdraw funds.");
                return;
            }

            // First get payment method selection
            const paymentMethod = await new Promise((resolve, reject) => {
                const messageOptions = {
                    reply_markup: {
                        inline_keyboard: [
                            // Automatic pyment method
                            [
                                { text: "Telebirr SantimPay 💳", callback_data: "withdraw_telebirr" }
                            ]

                        ]
                    }
                };

                bot.sendMessage(chatId, "Select withdrawal method:", messageOptions)
                    .then(sentMsg => {
                        const handler = (callbackQuery) => {
                            if (callbackQuery.message.chat.id === chatId &&
                                callbackQuery.message.message_id === sentMsg.message_id) {
                                bot.removeListener('callback_query', handler);
                                resolve(callbackQuery.data.replace('withdraw_', ''));
                            }
                        };

                        bot.on('callback_query', handler);

                        // 2-minute timeout
                        setTimeout(() => {
                            bot.removeListener('callback_query', handler);
                            reject(new Error('Payment method selection timeout'));
                        }, 120000);
                    });
            });

            // 2. Account number collection
            let accountPrompt;
            let validator;

            if (paymentMethod === 'telebirr') {
                accountPrompt = "📱 Enter Telebirr phone number to withdraw money";
                validator = (text) => /^09\d{8}$/.test(text);
            } else {
                await bot.sendMessage(chatId, "🚧 This withdrawal method is coming soon!");
                await session.abortTransaction();
                return;
            }

            const accountNumber = await getValidInput(bot, chatId, accountPrompt, validator);
            if (!accountNumber) return;

            // NEW FORMATTING LOGIC
            const formattedAccount = accountNumber.replace(/^0/, '+251');

            // 3. Amount collection
            let amount = await getValidInput(
                bot,
                chatId,
                "💰 Enter amount to withdraw (30 ETB - 2000 ETB):",
                (text) => parseFloat(text) >= 1 && parseFloat(text) <= 2000
            );
            if (!amount) return;


            // Add balance check
            if (user.balance < parseFloat(amount)) {
                await bot.sendMessage(chatId, "❌ Insufficient balance for withdrawal.");
                return;
            }

            // Create transaction record FIRST
            const id = Math.floor(Math.random() * 1000000000).toString();
            const transactionNew = new Finance({
                transactionId: id,
                chatId: chatId,
                amount: amount,
                status: "COMPLETED",
                type: 'withdrawal',
                paymentMethod: paymentMethod,
                accountNumber: formattedAccount
            });

            // Update user balance INSIDE TRANSACTION
            user.balance -= parseFloat(amount);

            // ATOMIC OPERATION
            await Promise.all([
                transactionNew.save({ session }),
                user.save({ session })
            ]);

            // Wrap Santimpay transaction in session-aware promise
            await new Promise((resolve, reject) => {
                client.sendToCustomer(id, amount, "withdrawal", formattedAccount, "Telebirr", notifyUrl)
                    .then(async response => {
                        console.log("response", response);
                        const transaction = await client.checkTransactionStatus(id);
                        console.log("Transaction: ", transaction);
                        
                        if (transaction.status !== 'COMPLETED') {
                            throw new Error('Santimpay transaction failed');
                        }
                        resolve();
                    })
                    .catch(error => {
                        console.error(error);
                        reject(new Error('Payment processing failed'));
                    });
            }); 
            // new old 

            // COMMIT TRANSACTION ONLY AFTER SUCCESSFUL SAVES AND PAYMENT PROCESSING
            await session.commitTransaction();

            // Moved admin notifications AFTER successful commit
            const adminMessage = `✅ Withdraw Approved for @${user.username || chatId}. Amount: ${amount} Birr \nPhone: ${formattedAccount}`;
            await Promise.all([
                bot.sendMessage(1982046925, adminMessage),
                bot.sendMessage(415285189, adminMessage),
                bot.sendMessage(923117728, adminMessage)
            ]);

        } catch (error) {
            // ROLLBACK ON ANY ERRORS
            await session.abortTransaction();
            console.error("Withdrawal Error:", error);
            await bot.sendMessage(chatId, "❌ Withdrawal failed - balance reversed. Please try again...");
        } finally {
            session.endSession();
        }
    },

    transfer: async (chatId, bot) => {
        const session = await User.startSession();
        try {
            const sender = await User.findOne({ chatId }).session(session);
            if (!sender) {
                await bot.sendMessage(chatId, "Please register first to transfer funds.");
                return;
            }

            // SWAPPED ORDER: PHONE FIRST THEN AMOUNT
            const recipientPhone = await getValidInput(
                bot,
                chatId,
                "Enter receivers's phone number (format: 09xxxxxxxx):",
                (text) => /^09\d{8}$/.test(text)
            );

            // Find recipient by phone number FIRST
            const recipient = await User.findOne({ phoneNumber: recipientPhone }).session(session);
            if (!recipient) {
                await bot.sendMessage(chatId, "Recipient not found. Please check the phone number and try again.");
                return;
            }

            // Prevent self-transfer EARLIER IN FLOW
            if (recipient.chatId === chatId) {
                await bot.sendMessage(chatId, "You cannot transfer to yourself.");
                return;
            }

            // NOW GET AMOUNT AFTER RECIPIENT VERIFICATION
            const amount = await getValidInput(
                bot,
                chatId,
                "Enter amount to transfer (30 ETB - 2000 ETB):",
                (text) => {
                    const num = parseFloat(text);
                    return !isNaN(num) && num >= 30 && num <= 2000;
                }
            );

            // Check if sender has sufficient balance (UNCHANGED)
            if (sender.balance < parseFloat(amount)) {
                await bot.sendMessage(chatId, "Insufficient balance for this transfer.");
                return;
            }

            // AFTER GETTING RECIPIENT PHONE NUMBER, ADD CONFIRMATION STEP
            await session.startTransaction();

            // Create confirmation message
            const confirmMessage = `⚠️ Confirm Transfer:\nAmount: ${amount} ETB\nTo: ${recipientPhone}`;

            // Send confirmation with buttons
            const { message_id } = await bot.sendMessage(chatId, confirmMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Confirm Transfer", callback_data: "confirm_transfer" }],
                        [{ text: "❌ Cancel", callback_data: "cancel_transfer" }]
                    ]
                }
            });

            // Wait for confirmation
            const confirmed = await new Promise((resolve) => {
                const handler = async (callbackQuery) => {
                    if (callbackQuery.message.chat.id === chatId &&
                        callbackQuery.message.message_id === message_id) {
                        resolve(callbackQuery.data === "confirm_transfer");
                    }
                };
                bot.on('callback_query', handler);

                // 2-minute timeout
                setTimeout(() => resolve(false), 120000);
            });

            if (!confirmed) {
                await session.abortTransaction();
                await bot.sendMessage(chatId, "❌ Transfer cancelled");
                return;
            }

            // PROCEED WITH EXISTING TRANSFER LOGIC ONLY AFTER CONFIRMATION
            // Atomic transfer operation
            sender.balance -= parseFloat(amount);
            recipient.balance += parseFloat(amount);

            await sender.save({ session });
            await recipient.save({ session });

            const transactionId = Math.floor(Math.random() * 1000000000).toString();

            await new Finance({
                transactionId,
                chatId,
                recipientChatId: recipient.chatId,
                amount: parseFloat(amount),
                status: 'COMPLETED',
                type: 'transfer',
                paymentMethod: "InAppTransfer"
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
        }
    },
};

module.exports = transactionHandlers; 
