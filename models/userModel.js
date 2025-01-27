const mongoose = require("mongoose"); 
const Schema = mongoose.Schema;

const userSchema = new Schema({
    chatId: {
        type: Number,
        required: true,
        unique: true,
    },
    phoneNumber: {
        type: String,
        // required: true,
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
    role: {
        type: Boolean,
        default: 0  // 0 = player, 1 = admin
    }
}, {
    timestamps: true,
});

const User = mongoose.model("User", userSchema);

module.exports = User;

