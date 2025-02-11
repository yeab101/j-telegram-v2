const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const userSchema = new Schema({
    chatId: {
        type: Number,
        required: true,
        unique: true,
        index: true
    },
    phoneNumber: {
        type: String, 
        unique: true, 
    },
    username: {
        type: String,
        required: true,
    },
    balance: {
        type: Number,
        default: 0,
    },
    bonus: {
        type: Number,
        default: 0,
    },
    firstname: {
        type: String,
    },
    referredBy: {
        type: Number,
        default: null
    },
    referralCount: {
        type: Number,
        default: 0
    },
    bonusReceived: {
        type: Boolean,
        default: false
    },
    role: {
        type: Boolean,
        default: 0   
    },
    banned: {
        type: Boolean,
        default: false
    }


}, {
    timestamps: true,
});

const User = mongoose.model("User", userSchema);

module.exports = User;
