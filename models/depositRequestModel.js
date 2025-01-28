const mongoose = require('mongoose');

const depositRequestSchema = new mongoose.Schema({
    transactionId: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    chatId: {
        type: String,
        required: true, 
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    bank: {
        type: String,
        default: 'CBE',
    }
}, { timestamps: true });

module.exports = mongoose.model('DepositRequest', depositRequestSchema); 