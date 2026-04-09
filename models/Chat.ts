import mongoose from "mongoose";

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

export const Chat = mongoose.model("Chat", chatSchema);
