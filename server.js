const express = require("express");
const CryptoJS = require("crypto-js");
const stringifySafe = require("json-stringify-safe");
const { MongoClient, ServerApiVersion } = require("mongodb");
const axios = require("axios");
const path = require('path');
const session = require("express-session");
const MongoStore = require('connect-mongo');
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");

// Initialize express application
const app = express();

// Configure encryption and session stores safely
app.use(session({
  secret: process.env.SESSION_SECRET || '8f4d92a1c6b7e5f3a0d7c2b9e4a8f1d0c5b3a6e9f2d8c7b4a1e0f9d8c7b6a5e4',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: process.env.MONGO_URI 
  }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // Keeps users logged in for 1 day
}));

// Setup HTTP and Socket.IO server instances
const server = http.createServer(app);
const io = new Server(server);

// Define global variables and admin lists
let requests = [];
const admins = ["admin"]; // Add your admin usernames to this array

// Middleware functions
app.use((req, res, next) => {
  console.log('Request URL:', req.url);
  next();
});

app.use((req, res, next) => {
  if (req.path !== '/' && req.path.startsWith('/site/')) {
    req.url = req.url.replace('/site', '');
  }
  if (req.path !== '/' && req.path.startsWith('/panel/')) {
    req.url = req.url.replace('/panel', '');
  }
  if (req.path.endsWith('.html')) {
    return res.redirect(301, req.path.slice(0, -5));
  }
  next();
});

// Helper utilities
function formatDateTime(dateTime) {
  const options = {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hour12: true,
  };
  return dateTime.toLocaleString(undefined, options);
}

const byte = (str) => {
  return Buffer.byteLength(str, 'utf8');
};

function encrypt(text, pass) {
  return CryptoJS.AES.encrypt(text, pass).toString();
}

function decrypt(text, pass) {
  return CryptoJS.AES.decrypt(text, pass).toString(CryptoJS.enc.Utf8);
}

function rand(min, max) {
  return Math.random() * (max - min + 1) + min;
}

// MongoDB database connection handling
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const db_name = "pixelit";
const db = client.db(db_name);
const users = db.collection("users");
const badges = db.collection("badges");
const news = db.collection("news");
const chatm = db.collection("chat");
const packs = db.collection("packs");

async function run() {
  try {
    await client.connect();
    await client.db(db_name).command({ ping: 1 });
    requests = await client.db(db_name).collection("requests").find().toArray();
    console.log("Successfully connected to the database");
  } catch (e) {
    console.error("Database connection failure:", e);
  }
}
run().catch(console.dir);

// Router and Static assets routing setup
const router = require("./routes.js");
app.use(router);
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

// Socket.IO event gateway connections
io.on("connection", (socket) => {
  console.log("a user connected");
  
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
  
  socket.on("getTokens", async (name) => {
    const user = await users.findOne({ username: name });
    if (user === null) return;
    io.to(socket.id).emit("tokens", user.tokens, user.sent, user.packsOpened);
  });
  
  socket.on("message", async (message) => {
    console.log("sending message");
    try {
        if (byte(message) > 1000 || message.trim() === "") {
          console.log("message too long or empty");
          return;
        }

        const cookief = socket.handshake.headers.cookie;
        console.log("getting response");
        const response = await axios.get(
            "https://replit.app",
            {
                headers: {
                    Cookie: cookief,
                },
                validateStatus: function (status) {
                    return (status >= 200 && status < 300) || status === 500; 
                },
                withCredentials: true,
            },
        );
        console.log(response);
        if (response.status !== 500) {
            const name = response.data.username;
            const d = new Date();
            const user = await users.findOne({ username: name });
            const chatmessage = {
                sender: name,
                msg: message,
                badges: user.badges,
                pfp: user.pfp,
            };

            await chatm.insertOne(chatmessage);
            await users.updateOne(
                { username: name },
                { \$set: { sent: user.sent + 1, tokens: user.tokens + 1 } },
            );

            io.emit("chatupdate", "get");
            console.log("message sent");
        } else {
            socket.emit("error", response.data);
        }
    } catch (error) {
        console.error("Error during message handling:", error);
    }
  });

  socket.on("getChat", async () => {
    socket.emit("chatupdate", await chatm.find().toArray());
  });
  
  socket.on("getNews", async () => {
    const newsPosts = await news.find().toArray();
    io.to(socket.id).emit("getNews", newsPosts);
  });
  
  socket.on("newspost", async (info) => {
    const newsPost = {
      title: info.title,
      content: info.content,
      author: info.author,
      date: info.date,
    };
    if (admins.includes(info.author)) {
      await news.insertOne(newsPost);
      console.log("posted news: " + info.title);
    }
  });
  
  socket.on("addPack", async (pack, user) => {
    const newpack = {
      name: pack.name,
      image: pack.image,
      cost: pack.cost,
      blooks: [],
    };
    if (admins.includes(user.name)) {
      try {
        await packs.insertOne(newpack);
        await users.updateMany(
            { packs: { \$nin: [pack.name] } },
            { \$push: { packs: newpack } }
        );
      } catch (e) {
        console.log(e);
      }
      console.log("added new pack: " + newpack.name);
      io.to(socket.id).emit("getPacks", "get");
    } else console.log("addpack verification denied " + user.name);
  });
  
  socket.on("addBlook", async (blook, user) => {
    if (admins.includes(user.name)) {
      await packs.updateOne(
        { name: blook.parent },
        {
          \$push: {
            blooks: {
              name: blook.name,
              image: blook.image
            }
          }
        }
      );
    }
  });
});

// Listen on the dynamic cloud host port assignment
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
