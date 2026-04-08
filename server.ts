import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cors from "cors";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- MongoDB Setup ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://carmaa786:carmaaxyz123@cluster0.rvwf0.mongodb.net/carmaa?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch(err => console.error("MongoDB connection error:", err));

const chatSchema = new mongoose.Schema({
  userId: { type: String, index: true }, // Phone number or Social ID
  platform: { type: String, index: true }, // 'whatsapp', 'messenger', 'instagram', 'web'
  leadScore: { type: String, enum: ['cold', 'warm', 'hot'], default: 'cold', index: true },
  scoreReason: String,
  messages: [{
    role: String, // 'user', 'model'
    text: String,
    timestamp: { type: Date, default: Date.now }
  }],
  lastUpdated: { type: Date, default: Date.now, index: true }
});

chatSchema.index({ userId: 1, platform: 1 }, { unique: true });

const Chat = mongoose.model("Chat", chatSchema);

// Near-zero latency context cache for active sessions
const contextCache = new Map<string, any[]>();

// Simple JS-based Lead Scorer
function calculateLeadScore(messages: any[]) {
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.text.toLowerCase());
  const combinedText = userMessages.join(' ');

  const hotKeywords = ['book', 'price', 'cost', 'kitna', 'address', 'location', 'appointment', 'today', 'urgent'];
  const warmKeywords = ['service', 'wash', 'cleaning', 'detail', 'offer', 'discount', 'how', 'kya'];

  let score = 'cold';
  let reason = 'Initial inquiry';

  const hasHot = hotKeywords.some(k => combinedText.includes(k));
  const hasWarm = warmKeywords.some(k => combinedText.includes(k));

  if (hasHot || userMessages.length > 5) {
    score = 'hot';
    reason = 'High intent detected (booking/pricing keywords or long conversation)';
  } else if (hasWarm || userMessages.length > 2) {
    score = 'warm';
    reason = 'Moderate interest (service keywords or multiple messages)';
  }

  return { score, reason };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // In-memory log for debugging webhooks
  let webhookLogs: any[] = [];

  // API: Health & Logs
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      logs: webhookLogs.slice(-10)
    });
  });

  // API: Fetch Real Chats for Dashboard with Pagination & Filtering
  app.get("/api/chats", async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const platform = req.query.platform as string;
      const skip = (page - 1) * limit;

      const query: any = {};
      if (platform && platform !== 'all') {
        query.platform = platform;
      }

      const total = await Chat.countDocuments(query);
      const chats = await Chat.find(query)
        .sort({ lastUpdated: -1 })
        .skip(skip)
        .limit(limit);

      res.json({
        chats,
        total,
        page,
        totalPages: Math.ceil(total / limit)
      });
    } catch (error) {
      console.error("Error fetching chats:", error);
      res.status(500).json({ error: "Failed to fetch chats" });
    }
  });

  // API: Fetch Platform Distribution Stats
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await Chat.aggregate([
        { $group: { _id: "$platform", count: { $sum: 1 } } }
      ]);
      
      const distribution = stats.reduce((acc: any, curr: any) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {});

      res.json(distribution);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // API: Save Manual Response from Dashboard
  app.post("/api/chat/manual", async (req, res) => {
    const { userId, text } = req.body;
    try {
      let chat = await Chat.findOne({ userId });
      if (chat) {
        chat.messages.push({ role: 'model', text, timestamp: new Date() });
        chat.lastUpdated = new Date();
        await chat.save();
        res.json({ success: true, chat });
      } else {
        res.status(404).json({ error: "Chat not found" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to save manual response" });
    }
  });

  // --- Gemini Setup ---
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  
  const CARMAA_CONTEXT = `
    You are "Carmaa Bro", the chillest AI Sales Rep for Carmaa (premium door-to-door car service in India).
    
    Vibe:
    - Informal, humorous, and slightly "Instagram-y". 
    - Use Hinglish (mix of Hindi and English) naturally.
    - Be witty but helpful. No "robotic" corporate speak.
    - Use emojis like 🚗✨🧼🔥.
    - Treat the user like a friend but keep the goal in mind: BOOKING.
    
    Services (The "Menu"):
    1. Basic Wash (₹499): "Exterior chamka denge" (Exterior wash + tire polish).
    2. Deep Interior (₹1499): "Andar se naya jaisa" (Vacuum + polish + seat dry clean).
    3. Full Detailing (₹2999): "The Works" (Wash + Deep Clean + Wax).
    4. Oil Change/Service (₹2499+): "Health checkup for your beast".
    
    Offers:
    - First booking? Use CARMAA20 for 20% off. "Pehli baar hai toh discount banta hai!"
    - Refer a friend? ₹200 off. "Dost ka bhala, aapka bhi bhala."
    
    Rules:
    - If they ask for price, give it with a joke.
    - If they hesitate, say "Gaadi gandi acchi nahi lagti bro, book karlo!"
    - Keep it short. WhatsApp/Insta users don't read essays.
  `;

  // --- Webhook Handling ---

  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!mode && !token) {
      return res.status(200).send("Carmaa Webhook is LIVE. Meta is welcome.");
    }

    const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || "carmaa_secret").trim();

    if (mode === "subscribe" && token === expectedToken) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Verification failed");
    }
  });

  app.post("/webhook", async (req, res) => {
    const body = req.body;
    webhookLogs.push({ time: new Date().toISOString(), method: "POST", body });
    if (webhookLogs.length > 50) webhookLogs.shift();

    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0]?.changes?.[0]?.value;
      if (entry?.messages?.[0]) {
        const phone_number_id = entry.metadata.phone_number_id;
        const from = entry.messages[0].from;
        const msg_text = entry.messages[0].text?.body || "";
        await handleMessage(from, msg_text, 'whatsapp', phone_number_id);
      }
      return res.sendStatus(200);
    }

    if (body.object === "page" || body.object === "instagram") {
      const entry = body.entry?.[0]?.messaging?.[0];
      if (entry?.message) {
        const senderId = entry.sender.id;
        const msg_text = entry.message.text || "";
        const platform = body.object === "instagram" ? "instagram" : "messenger";
        await handleMessage(senderId, msg_text, platform);
      }
      return res.sendStatus(200);
    }

    res.sendStatus(404);
  });

  // --- Web Chat API ---
  app.post("/api/chat/web", async (req, res) => {
    const { userId, text } = req.body;
    if (!userId || !text) return res.status(400).json({ error: "Missing data" });
    
    const aiResponse = await handleMessage(userId, text, 'web');
    res.json({ text: aiResponse });
  });

  // API Catch-all to prevent HTML responses for missing API routes
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  async function handleMessage(userId: string, text: string, platform: string, phoneId?: string) {
    const cacheKey = `${platform}:${userId}`;
    try {
      // 1. Get context (Cache first, then DB)
      let messages = contextCache.get(cacheKey);
      let chat;

      if (!messages) {
        chat = await Chat.findOne({ userId, platform });
        if (!chat) {
          chat = new Chat({ userId, platform, messages: [] });
        }
        messages = chat.messages;
      }

      // 2. Add user message
      const userMsg = { role: "user", text, timestamp: new Date() };
      messages.push(userMsg);

      // 3. Prepare AI context (Last 10 messages for deep context)
      const history = messages.slice(-10).map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }]
      }));

      // 4. Generate AI Response
      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-latest",
        contents: history,
        config: { systemInstruction: CARMAA_CONTEXT },
      });

      const aiResponse = response.text || "Bro, server thoda slow hai, ek min ruko!";
      const modelMsg = { role: "model", text: aiResponse, timestamp: new Date() };
      messages.push(modelMsg);

      // 5. Update Cache (Keep last 20 in memory)
      contextCache.set(cacheKey, messages.slice(-20));

      // 6. Background DB Update (Don't block the response)
      (async () => {
        if (!chat) chat = await Chat.findOne({ userId, platform }) || new Chat({ userId, platform, messages: [] });
        chat.messages = messages; // Full history in DB
        const { score, reason } = calculateLeadScore(chat.messages);
        chat.leadScore = score as any;
        chat.scoreReason = reason;
        chat.lastUpdated = new Date();
        await chat.save();
      })().catch(err => console.error("DB Update Error:", err));

      // 7. Platform Specific Send
      if (platform === 'whatsapp' && phoneId && process.env.WHATSAPP_TOKEN) {
        await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
          messaging_product: "whatsapp",
          to: userId,
          text: { body: aiResponse },
        }, {
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
        });
      }
      
      return aiResponse;
    } catch (error) {
      console.error("Error in handleMessage:", error);
      return "Sorry bro, something went wrong!";
    }
  }

  // --- Website Widget Script ---
  app.get("/widget.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(`
      (function() {
        // Use the current origin as the API base
        const API_BASE = window.location.origin;
        
        const initWidget = () => {
          if (document.getElementById('carmaa-chat-widget')) return;
          
          const config = window.CarmaaAIConfig || { themeColor: '#ea580c', title: 'Carmaa Bro 🚗' };
          
          const div = document.createElement('div');
          div.id = 'carmaa-chat-widget';
          div.style.position = 'fixed';
          div.style.bottom = '20px';
          div.style.right = '20px';
          div.style.zIndex = '999999';
          div.style.fontFamily = 'sans-serif';
          div.innerHTML = \`
            <button id="carmaa-toggle" style="background: \${config.themeColor}; color: #fff; border: none; padding: 15px 25px; border-radius: 50px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-weight: bold; display: flex; align-items: center; gap: 10px; transition: transform 0.2s;">
              <span>Chat with Carmaa Bro</span> 🚗
            </button>
            <div id="carmaa-box" style="display: none; width: 350px; height: 500px; background: #fff; border: 1px solid #eee; border-radius: 20px; margin-bottom: 15px; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.15); overflow: hidden;">
              <div style="padding: 20px; background: \${config.themeColor}; color: #fff; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
                <span>\${config.title}</span>
                <button id="carmaa-close" style="background: none; border: none; color: #fff; cursor: pointer; font-size: 20px;">&times;</button>
              </div>
              <div id="carmaa-msgs" style="flex: 1; overflow-y: auto; padding: 20px; background: #f9f9f9; display: flex; flex-direction: column; gap: 10px;">
                <div style="text-align: left;"><span style="background: #fff; border: 1px solid #eee; padding: 10px 14px; border-radius: 18px; border-bottom-left-radius: 4px; display: inline-block; max-width: 85%; font-size: 14px; line-height: 1.4;">Namaste! Carmaa Bro here. Gaadi chamkani hai? 🔥</span></div>
              </div>
              <div id="carmaa-typing" style="display: none; padding: 5px 20px; font-size: 12px; color: #999;">Bro is typing...</div>
              <div style="padding: 15px; border-top: 1px solid #eee; display: flex; gap: 8px; background: #fff;">
                <input id="carmaa-input" type="text" placeholder="Type a message..." style="flex: 1; border: 1px solid #ddd; padding: 10px 15px; border-radius: 25px; outline: none; font-size: 14px;">
                <button id="carmaa-send" style="background: \${config.themeColor}; color: #fff; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold;">&rarr;</button>
              </div>
            </div>
          \`;
          document.body.appendChild(div);
          
          const toggle = document.getElementById('carmaa-toggle');
          const close = document.getElementById('carmaa-close');
          const box = document.getElementById('carmaa-box');
          const input = document.getElementById('carmaa-input');
          const send = document.getElementById('carmaa-send');
          const msgs = document.getElementById('carmaa-msgs');
          const typing = document.getElementById('carmaa-typing');
          
          let userId = localStorage.getItem('carmaa_user_id') || 'web_' + Math.random().toString(36).substr(2, 9);
          localStorage.setItem('carmaa_user_id', userId);

          const toggleChat = () => {
            const isHidden = box.style.display === 'none';
            box.style.display = isHidden ? 'flex' : 'none';
            toggle.style.display = isHidden ? 'none' : 'flex';
            if(isHidden) input.focus();
          };

          toggle.onclick = toggleChat;
          close.onclick = toggleChat;
          
          const appendMsg = (text, isUser) => {
            const msgDiv = document.createElement('div');
            msgDiv.style.textAlign = isUser ? 'right' : 'left';
            msgDiv.innerHTML = \`<span style="background: \${isUser ? config.themeColor : '#fff'}; color: \${isUser ? '#fff' : '#333'}; border: \${isUser ? 'none' : '1px solid #eee'}; padding: 10px 14px; border-radius: 18px; \${isUser ? 'border-bottom-right-radius: 4px' : 'border-bottom-left-radius: 4px'}; display: inline-block; max-width: 85%; font-size: 14px; line-height: 1.4; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">\${text}</span>\`;
            msgs.appendChild(msgDiv);
            msgs.scrollTop = msgs.scrollHeight;
          };

          const handleSend = async () => {
            const text = input.value.trim();
            if(!text) return;
            input.value = '';
            appendMsg(text, true);
            
            typing.style.display = 'block';
            try {
              const res = await fetch(\`\${API_BASE}/api/chat/web\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, text })
              });
              const data = await res.json();
              appendMsg(data.text, false);
            } catch (e) {
              appendMsg("Sorry bro, connection issue. Try again!", false);
            } finally {
              typing.style.display = 'none';
            }
          };

          send.onclick = handleSend;
          input.onkeypress = (e) => { if(e.key === 'Enter') handleSend(); };
        };

        if (document.readyState === 'complete') {
          initWidget();
        } else {
          window.addEventListener('load', initWidget);
        }
      })();
    `);
  });

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
