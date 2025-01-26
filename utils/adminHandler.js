const User = require("../models/userModel");
const BingoGame = require("../models/bingoGameModel"); 
const jwt = require('jsonwebtoken');

const checkAdmin = async (chatId) => {
    const user = await User.findOne({ chatId });
    if (!user || !user.role) {
        throw new Error("Unauthorized access");
    }
    return user;
};

const adminHandler = {
    checkAdminStatus: async (chatId, bot) => {
        try {
            // Find user in database
            const user = await User.findOne({ chatId });

            // Handle non-existent user
            if (!user) {
                throw new Error("User not found");
            }

            if (user.role) {
                // Create a JWT token for admin dashboard access
                const token = jwt.sign(
                    { 
                        chatId,
                        role: user.role,
                        exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour expiration
                    },
                    process.env.JWTPRIVATEKEY
                );

                console.log("token", token)

                // Send single admin menu message
                await bot.sendMessage(chatId, "👑 Admin Control Panel", {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "Admin Dashboard 📊", web_app: { url: `${process.env.CLIENT_URL}/admin?token=${token}&chatId=${chatId}` }}

                            ],
                            [
                                { text: "Announcements 📢", callback_data: "admin_announce" }
                            ], 
                            // System Controls
                            [
                                { text: "Game Settings ⚙️", callback_data: "admin_settings" },
                                // { text: "System Stats 📊", callback_data: "admin_stats" }
                            ],
                            // User Controls 
                            [
                                { text: "Search User 🔍", callback_data: "admin_search" },
                                { text: "Block User 🚫", callback_data: "admin_block" }
                            ],
                        ]
                    }
                });
            } else {
                // Regular player message
                await bot.sendMessage(chatId, "Invalid command try again ");
            }
        } catch (error) {
            console.error("Admin check error:", error);
            await bot.sendMessage(chatId, "Error checking admin status");
        }
    },


    handleGameSettings: async (chatId, bot) => {
        try {
            await checkAdmin(chatId);
            await bot.sendMessage(chatId, "⚙️ Game Settings", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Set Cut %", callback_data: "settings_cut" }
                        ],
                        [
                            { text: "Back to Admin Menu", callback_data: "admin_menu" }
                        ]
                    ]
                }
            });
        } catch (error) {
            console.error("Error:", error);
            await bot.sendMessage(chatId, "Unauthorized access");
        }
    },

     

    handleCutSettings: async (chatId, bot) => {
        try {
            await bot.sendMessage(chatId, "Enter new platform cut percentage (1-20%):", {
                reply_markup: {
                    force_reply: true
                }
            });

            // Listen for the response
            bot.once('message', async (msg) => {
                const percentage = parseInt(msg.text);
                if (isNaN(percentage) || percentage < 1 || percentage > 20) {
                    await bot.sendMessage(chatId, "Invalid percentage. Please enter a number between 1 and 20.");
                    return;
                }

                // Update the latest game's cut percentage
                const currentGame = await BingoGame.findOne().sort({ createdAt: -1 });
                if (currentGame) {
                    currentGame.cutPercentage = percentage;
                    await currentGame.save();
                    await bot.sendMessage(chatId, `Platform cut percentage updated to ${percentage}%`);
                } else {
                    await bot.sendMessage(chatId, "No active game found");
                }
            });
        } catch (error) {
            console.error("Error handling cut settings:", error);
            await bot.sendMessage(chatId, "Error updating platform cut percentage");
        }
    },

    handleUserSearch: async (chatId, bot) => {
        try {
            await bot.sendMessage(chatId, "Enter user's phone number to search:", {
                reply_markup: {
                    force_reply: true
                }
            });

            // Listen for the response
            bot.once('message', async (msg) => {
                const phoneNumber = msg.text;
                const user = await User.findOne({ phoneNumber });

                if (user) {
                    const userInfo =
                        `👤 User Information:\n\n` +
                        `Username: ${user.username}\n` +
                        `Phone: ${user.phoneNumber}\n` +
                        `Balance: ${user.balance} ETB\n` +
                        `Role: ${user.role ? 'Admin' : 'Player'}\n` +
                        `Referrals: ${user.referralCount}\n` +
                        `Status: ${user.isBlocked ? 'Blocked' : 'Active'}`;

                    await bot.sendMessage(chatId, userInfo);
                } else {
                    await bot.sendMessage(chatId, "User not found");
                }
            });
        } catch (error) {
            console.error("Error searching user:", error);
            await bot.sendMessage(chatId, "Error searching for user");
        }
    },

    handleUserBlock: async (chatId, bot) => {
        try {
            await bot.sendMessage(chatId, "Enter user's phone number to block/unblock:", {
                reply_markup: {
                    force_reply: true
                }
            });

            // Listen for the response
            bot.once('message', async (msg) => {
                const phoneNumber = msg.text;
                const user = await User.findOne({ phoneNumber });

                if (user) {
                    // Toggle block status
                    user.isBlocked = !user.isBlocked;
                    await user.save();

                    const status = user.isBlocked ? 'blocked' : 'unblocked';
                    await bot.sendMessage(chatId, `User has been ${status}`);

                    // If blocked, notify the user
                    if (user.isBlocked) {
                        try {
                            await bot.sendMessage(user.chatId,
                                "Your account has been blocked by admin. Please contact support."
                            );
                        } catch (error) {
                            console.error("Error notifying blocked user:", error);
                        }
                    }
                } else {
                    await bot.sendMessage(chatId, "User not found");
                }
            });
        } catch (error) {
            console.error("Error blocking user:", error);
            await bot.sendMessage(chatId, "Error blocking/unblocking user");
        }
    },

    handleAnnouncement: async (chatId, bot) => {
        try {
            await bot.sendMessage(chatId, "Enter your announcement message:", {
                reply_markup: {
                    force_reply: true
                }
            });

            // Listen for the response
            bot.once('message', async (msg) => {
                const announcement = msg.text;

                // Get all users
                const users = await User.find({}, 'chatId');
                let successCount = 0;
                let failCount = 0;

                // Send announcement to each user
                for (const user of users) {
                    try {
                        await bot.sendMessage(user.chatId,
                            `${announcement}`
                        );
                        successCount++;
                    } catch (error) {
                        console.error(`Error sending announcement to ${user.chatId}:`, error);
                        failCount++;
                    }
                    // Add a small delay to avoid hitting rate limits
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                // Report results to admin
                await bot.sendMessage(chatId,
                    `Announcement sent!\n` +
                    `✅ Successfully sent to: ${successCount} users\n` +
                    `❌ Failed to send to: ${failCount} users`
                );
            });
        } catch (error) {
            console.error("Error sending announcement:", error);
            await bot.sendMessage(chatId, "Error sending announcement");
        }
    }, 
};

module.exports = adminHandler; 