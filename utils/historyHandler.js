const Finance = require("../models/financeModel");
const Transaction = require("../models/transactionModel");  

const historyHandlers = {
    showHistory: async (chatId, bot) => {
        try {
            const transactions = await Finance.find({
                $or: [
                    { chatId: chatId },
                    { recipientChatId: chatId }
                ]
            })
                .sort({ updatedAt: -1 })
                .limit(10);

            if (!transactions || transactions.length === 0) {
                await bot.sendMessage(chatId, "No transaction history found.");
                return;
            }

            await bot.sendMessage(chatId, "Last 10 Transactions:");

            // Send each transaction as a separate message
            for (const [index, transaction] of transactions.entries()) {
                const date = new Date(transaction.createdAt).toLocaleDateString();
                const type = transaction?.type?.toUpperCase();
                const amount = transaction?.amount;
                const status = transaction?.status?.toUpperCase();

                let details = '';
                if (transaction?.type === 'withdrawal') {
                    details = ` `;
                } else if (transaction?.type === 'transfer') {
                    details = transaction?.chatId === chatId
                        ? ` \n To: ${transaction?.recipientChatId}`
                        : ` \n From: ${transaction?.chatId}`;
                }

                if (transaction?.status === 'FAILED') {
                    details += ` \n Error: ${transaction?.status}`;
                }

                const message = `${index + 1}. ${date} \n ID: ${transaction.transactionId} \n ${type} \n Amount: ${amount} Birr \n Status: ${status}${details}`;

                // Add a small delay to prevent flooding
                await new Promise(resolve => setTimeout(resolve, 100));
                await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            }
        } catch (error) {
            console.error("Error fetching history:", error);
            await bot.sendMessage(chatId, "Error fetching transaction history. Please try again.");
        }
    },
    showGameHistory: async (chatId, bot) => {
        try {
            const transactions = await Transaction.find({ transaction_type: "credit" })
                .sort({ createdAt: -1 })
                .limit(10);

            if (!transactions || transactions.length === 0) {
                await bot.sendMessage(chatId, "No game history available.");
                return;
            }

            let message = "🎮 Recent Game Winners:\n\n";
            for (const transaction of transactions) { 
                message += `🎲 Game #${transaction.round_id}\n`;
                message += `👤 Winner: @${transaction.username}\n`;
                message += `💰 Prize: ${transaction.amount} Birr\n`;
                message += `⏰ ${new Date(transaction.createdAt).toLocaleString()}\n\n`;

            }

            await bot.sendMessage(chatId, message);
        } catch (error) {
            console.error('Error fetching game history:', error);
            await bot.sendMessage(chatId, "❌ Error fetching game history. Please try again later.");
        }
    }
};

module.exports = historyHandlers;
