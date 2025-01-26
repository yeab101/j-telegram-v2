require('dotenv').config();
const mongoose = require('mongoose');
const Finance = require('../models/financeModel'); 
// Note: using Finance model for target

// Database URLs
const sourceUrl = "mongodb+srv://yeabsera877:yeabsera877@cluster0.hsq5imh.mongodb.net/joker-bingo-00?retryWrites=true&w=majority&appName=Cluster0";
const targetUrl = "mongodb+srv://yeabseramelaku25:hhL47B22T8lsxrE9@classic-tech.klvtm.mongodb.net/joker-bingo-new-v2?retryWrites=true&w=majority&appName=classic-tech";

async function migrateTransactions() {
    let sourceDb;
    try {
        console.log('Connecting to databases...');
        
        await mongoose.connect(targetUrl);
        sourceDb = await mongoose.createConnection(sourceUrl);
        console.log('Connected to both databases');

        // Define Transaction schema for source database
        const transactionSchema = new mongoose.Schema({
            transactionId: { type: String, unique: true, required: true },
            chatId: { type: String, required: true },
            recipientChatId: { type: String },
            amount: { type: Number, required: true },
            status: { 
                type: String, 
                enum: ['COMPLETED', 'FAILED', 'DECLINED', 'PENDING_APPROVAL'],
                required: true 
            },
            type: {
                type: String,
                enum: ['deposit', 'withdrawal', 'transfer'],
                required: true
            },
            santimPayTxnId: { type: String },
            paymentMethod: { type: String }
        }, { timestamps: true });

        // Transactions Migration (from Transaction to Finance)
        console.log('\n=== Starting Transactions to Finance Migration ===');
        const TransactionCollection = sourceDb.model('Transaction', transactionSchema);
        const sourceTransactions = await TransactionCollection.find({}).lean();
        console.log(`Found ${sourceTransactions.length} transactions in source database`);
        
        let transactionsMigrated = 0;
        let transactionsSkipped = 0;
        let transactionsInvalid = 0;
        
        for (const transactionData of sourceTransactions) {
            try {
                console.log(`\nProcessing Transaction ID: ${transactionData.transactionId}`);
                
                const existingFinance = await Finance.findOne({ 
                    transactionId: transactionData.transactionId 
                });
                
                if (existingFinance) {
                    console.log(`⏭️ Skipping Transaction ${transactionData.transactionId}: Already exists in Finance collection`);
                    transactionsSkipped++;
                    continue;
                }
                
                if (!transactionData.transactionId || !transactionData.chatId || 
                    !transactionData.amount || !transactionData.status || !transactionData.type) {
                    console.log(`⚠️ Skipping Transaction ${transactionData.transactionId}: Missing required fields`);
                    transactionsInvalid++;
                    continue;
                }
                
                await Finance.create({
                    transactionId: transactionData.transactionId,
                    chatId: transactionData.chatId,
                    recipientChatId: transactionData.recipientChatId,
                    amount: transactionData.amount,
                    status: transactionData.status,
                    type: transactionData.type,
                    santimPayTxnId: transactionData.santimPayTxnId,
                    paymentMethod: transactionData.paymentMethod
                });
                
                console.log(`✅ Migrated to Finance: ${transactionData.transactionId} successfully`);
                transactionsMigrated++;
            } catch (error) {
                console.error(`❌ Failed to migrate to Finance ${transactionData.transactionId}:`, error.message);
                transactionsInvalid++;
            }
        }

        // Final Summary
        console.log('\n=== Final Migration Summary ===');
        console.log('Transactions to Finance:');
        console.log(`- Migrated: ${transactionsMigrated}`);
        console.log(`- Skipped: ${transactionsSkipped}`);
        console.log(`- Invalid: ${transactionsInvalid}`);
        console.log(`- Total processed: ${transactionsMigrated + transactionsSkipped + transactionsInvalid}`);
        
        console.log('\nTransaction to Finance Migration completed successfully');

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
migrateTransactions().catch(console.error); 