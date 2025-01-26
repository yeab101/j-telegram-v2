require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/userModel');

// Get URLs from environment variables
const sourceUrl = "mongodb+srv://yeabsera877:yeabsera877@cluster0.hsq5imh.mongodb.net/joker-bingo-00?retryWrites=true&w=majority&appName=Cluster0";
const targetUrl = "mongodb+srv://yeabseramelaku25:hhL47B22T8lsxrE9@classic-tech.klvtm.mongodb.net/joker-bingo-new-v2?retryWrites=true&w=majority&appName=classic-tech";



async function migrateMongoDB() {
    let sourceDb;
    try {
        console.log('Connecting to databases...');
        console.log(`Source DB: ${sourceUrl}`);
        console.log(`Target DB: ${targetUrl}`);
        
        await mongoose.connect(targetUrl);
        sourceDb = await mongoose.createConnection(sourceUrl);
        console.log('Connected to both databases');

        // Users Migration
        console.log('\n=== Starting Users Migration ===');
        const UserCollection = sourceDb.model('User', User.schema);
        const sourceUsers = await UserCollection.find({}).lean();
        console.log(`Found ${sourceUsers.length} users in source database`);
        
        let usersMigrated = 0;
        let usersSkipped = 0;
        let usersInvalid = 0;
        
        for (const userData of sourceUsers) {
            try {
                console.log(`\nProcessing User ChatID: ${userData.chatId}`);
                console.log(`Username: ${userData.username}`);
                
                const existingUser = await User.findOne({ chatId: userData.chatId });
                
                if (existingUser) {
                    console.log(`⏭️ Skipping User ${userData.chatId}: Already exists`);
                    usersSkipped++;
                    continue;
                }
                
                if (!userData.chatId || !userData.username) {
                    console.log(`⚠️ Skipping User ${userData.chatId}: Missing required fields`);
                    usersInvalid++;
                    continue;
                }
                
                await User.create({
                    chatId: userData.chatId,
                    phoneNumber: userData.phoneNumber,
                    username: userData.username,
                    balance: userData.balance || 100,
                    firstname: userData.firstname,
                    referredBy: userData.referredBy,
                    referralCount: userData.referralCount || 0,
                    role: userData.role || 0,
                });
                
                console.log(`✅ Migrated User ${userData.chatId} successfully`);
                usersMigrated++;
            } catch (error) {
                console.error(`❌ Failed to migrate user ${userData.chatId}:`, error.message);
                usersInvalid++;
            }
        }

        // Final Summary
        console.log('\n=== Final Migration Summary ===');
        console.log('Users:');
        console.log(`- Migrated: ${usersMigrated}`);
        console.log(`- Skipped: ${usersSkipped}`);
        console.log(`- Invalid: ${usersInvalid}`);
        console.log(`- Total processed: ${usersMigrated + usersSkipped + usersInvalid}`);
        
        console.log('\nMigration completed successfully');

    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        if (sourceDb) await sourceDb.close();
        await mongoose.disconnect();
        console.log('\nDatabase connections closed');
    }
}

// Execute migration
migrateMongoDB().catch(console.error); 