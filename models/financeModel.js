const mongoose = require('mongoose');
 
const financeSchema = new mongoose.Schema({
    transactionId: { type: String, unique: true, required: true },
    chatId: { type: String, required: true },
    recipientChatId: { type: String  },
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
    paymentMethod: { 
        type: String,  
    },
    approvedByUsername: { type: String},
    accountNumber: { type: String }
}, { timestamps: true });  

// Create the Finance model
const Finance = mongoose.model('Finance', financeSchema);

module.exports = Finance;