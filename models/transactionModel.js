const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({ 
    user_id: {
        type: String,
        required: true,
        index: true
    },
    username: {
        type: String,
        required: true
    }, 
    transaction_id: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    transaction_type: {
        type: String,
        enum: ['debit', 'credit', 'rollback'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed'],
        default: 'pending'
    }, 
    game: {
        type: String,
        default: 'Bingo'
    },
    round_id: {
        type: String,
        required: true,
        index: true
    },
    currency: {
        type: String,
        default: 'ETB'
    }, 
    debit_transaction_id: String,
    debit_round_id: String,
    
    // Additional flags
    payoutRequest: {
        type: Boolean,
        default: false
    },
    preBought: {
        type: Boolean,
        default: false
    },
    rollback: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true // Adds createdAt and updatedAt
});

// Indexes for common queries
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ user_id: 1, createdAt: -1 });
transactionSchema.index({ transaction_type: 1, status: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;