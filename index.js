// git pull check 
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http"); 
const connectToDatabase = require("./utils/db");  
const bot = require("./utils/telegramBot");

const mongoUrl = process.env.MONGOURL;
const PORT = process.env.PORT;

// App Configuration
const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
 
// Socket.io Configuration
const server = http.createServer(app); 

// Initialize Server
const startServer = async () => {
  try {
    await connectToDatabase(mongoUrl); 
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`); 
      console.log('Telegram bot is running...');
    });
  } catch (error) {
    console.error("Error connecting to the database:", error);
    process.exit(1);
  }
};

startServer();
