import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cors from "cors";
import { Chat } from "./models/Chat.ts";
import { User } from "./models/User.ts";
import { Service } from "./models/Service.ts";
import { Booking } from "./models/Booking.ts";
import { CarModel } from "./models/CarModel.ts";
import { AvailableSlots } from "./models/AvailableSlots.ts";
import { City } from "./models/City.ts";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- MongoDB Setup ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://carmaa786:carmaaxyz123@cluster0.rvwf0.mongodb.net/carmaa?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("MongoDB connection error:", err));

// --- In-Memory Caches ---
// Near-zero latency context cache for active sessions
const contextCache = new Map<string, any[]>();
// Deduplication cache for Meta webhooks
const processedMids = new Map<string, number>();
// Per-user booking draft state machine
const bookingDrafts = new Map<string, any>();
// Per-user full service list (for "show more" flow)
const userServiceCache = new Map<string, any[]>();

// Auto-cleanup old processed message IDs every 10 minutes
setInterval(() => {
  const now = Date.now();
  const expiry = 10 * 60 * 1000;
  processedMids.forEach((time, mid) => {
    if (now - time > expiry) processedMids.delete(mid);
  });
}, 5 * 60 * 1000);

// --- Lead Scorer ---
function calculateLeadScore(messages: any[]) {
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.text.toLowerCase());
  const combinedText = userMessages.join(' ');
  const hotKeywords = ['book', 'price', 'cost', 'kitna', 'address', 'location', 'appointment', 'today', 'urgent'];
  const warmKeywords = ['service', 'wash', 'cleaning', 'detail', 'offer', 'discount', 'how', 'kya'];
  let score = 'cold', reason = 'Initial inquiry';
  if (hotKeywords.some(k => combinedText.includes(k)) || userMessages.length > 5) {
    score = 'hot'; reason = 'High intent detected';
  } else if (warmKeywords.some(k => combinedText.includes(k)) || userMessages.length > 2) {
    score = 'warm'; reason = 'Moderate interest';
  }
  return { score, reason };
}

// --- Date Parser ---
function parseUserDate(text: string): string | null {
  const lower = text.toLowerCase().trim();
  const now = new Date();

  if (lower.includes('today') || lower.includes('aaj') || lower.includes('abhi')) {
    return now.toISOString().split('T')[0];
  }
  if (lower.includes('tomorrow') || lower.includes('kal') || lower.includes('kl')) {
    const tom = new Date(now); tom.setDate(now.getDate() + 1);
    return tom.toISOString().split('T')[0];
  }
  if (lower.includes('day after') || lower.includes('parso')) {
    const dat = new Date(now); dat.setDate(now.getDate() + 2);
    return dat.toISOString().split('T')[0];
  }

  // Try parsing explicit dates like "27 May", "5th April", "2026-05-27"
  const iso = lower.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const monthNames: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };
  const dateMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const month = monthNames[dateMatch[2]];
    if (month !== undefined) {
      const year = now.getMonth() > month ? now.getFullYear() + 1 : now.getFullYear();
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

// (Admin token is managed inside startServer via getAdminToken())

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  let webhookLogs: any[] = [];

  // API: Health & Logs
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString(), logs: webhookLogs.slice(-10) });
  });

  // API: Debug slots — GET /api/debug/slots?date=2026-04-11
  app.get("/api/debug/slots", async (req, res) => {
    try {
      const date = req.query.date as string || new Date().toISOString().split('T')[0];
      const regionId = req.query.region as string || process.env.FALLBACK_REGION_ID || '';
      const docs = await AvailableSlots.find({ date }).lean() as any[];
      const allDates = await AvailableSlots.distinct('date');
      res.json({
        queried: { date, regionId },
        totalDatesInDB: allDates.length,
        latestDates: allDates.sort().slice(-10),
        matchingDocs: docs.map(d => ({
          date: d.date,
          region: d.region?.toString(),
          weeklyOff: d.weeklyOff,
          slots: d.timeSlots?.map((s: any) => ({
            time: s.time,
            bookingCount: s.bookingCount,
            maxLimit: s.maxLimit,
            available: !s.maxLimit || s.bookingCount < s.maxLimit
          }))
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Fetch Real Chats for Dashboard
  app.get("/api/chats", async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const platform = req.query.platform as string;
      const search = req.query.search as string;
      const skip = (page - 1) * limit;
      const query: any = {};
      if (platform && platform !== 'all') query.platform = platform;
      if (search) {
        query.$or = [
          { userId: { $regex: search, $options: 'i' } },
          { platform: { $regex: search, $options: 'i' } }
        ];
      }
      const chats = await Chat.find(query).sort({ lastUpdated: -1 }).limit(limit * 2);
      let mergedResults = [...chats];
      if (search) {
        const isNumeric = /^\d+$/.test(search);
        const userQuery: any = {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { user_id: { $regex: search, $options: 'i' } }
          ]
        };
        if (isNumeric) {
          userQuery.$or.push({ mobile_number: Number(search) });
          if (search.startsWith('91') && search.length === 12) {
            userQuery.$or.push({ mobile_number: Number(search.substring(2)) });
          }
        }
        const users = await User.find(userQuery).limit(10);
        const userResults = await Promise.all(users.map(async (u: any) => {
          const resolvedData = await resolveUserData(u);
          const uId = u.mobile_number?.toString() || u.user_id;
          return {
            _id: u._id, userId: uId, name: u.name, platform: 'users_db',
            leadScore: 'cold', scoreReason: 'Full Customer Database Result',
            messages: [], lastUpdated: new Date(0), userProfile: resolvedData
          };
        }));
        userResults.forEach(ur => {
          if (!mergedResults.some(c => c.userId === ur.userId)) mergedResults.push(ur as any);
        });
      }
      const enrichedResults = await Promise.all(mergedResults.map(async (chat: any) => {
        if (chat.userProfile) return chat;
        try {
          const cleanId = chat.userId.replace(/\s+/g, '').replace('+', '');
          const isNumeric = /^\d+$/.test(cleanId);
          const q: any = { $or: [{ user_id: cleanId }] };
          if (isNumeric) {
            q.$or.push({ mobile_number: Number(cleanId) });
            if (cleanId.startsWith('91') && cleanId.length === 12) {
              q.$or.push({ mobile_number: Number(cleanId.substring(2)) });
            }
          }
          const profile = await User.findOne(q);
          const resolvedData = await resolveUserData(profile);
          return { ...chat.toObject?.() || chat, userProfile: resolvedData };
        } catch (err) {
          return chat;
        }
      }));
      const processedResults = enrichedResults
        .sort((a, b) => (b.lastUpdated?.getTime() || 0) - (a.lastUpdated?.getTime() || 0))
        .slice(skip, skip + limit);
      res.json({
        chats: processedResults,
        total: Math.max(chats.length, mergedResults.length),
        page,
        totalPages: Math.ceil(mergedResults.length / limit)
      });
    } catch (error) {
      console.error("Error fetching chats:", error);
      res.status(500).json({ error: "Failed to fetch chats" });
    }
  });

  // API: Stats
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await Chat.aggregate([{ $group: { _id: "$platform", count: { $sum: 1 } } }]);
      const distribution = stats.reduce((acc: any, curr: any) => { acc[curr._id] = curr.count; return acc; }, {});
      res.json(distribution);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // API: Manual Dashboard Reply
  app.post("/api/chat/manual", async (req, res) => {
    const { userId, text } = req.body;
    try {
      let chat = await Chat.findOne({ userId });
      if (!chat) return res.status(404).json({ error: "Chat not found" });
      console.log(`\n[${new Date().toLocaleTimeString()}] 💬 DASHBOARD MANUAL MESSAGE to ${userId}: "${text}"`);
      if (chat.platform === 'whatsapp' && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) {
        try {
          await axios.post(`https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
            messaging_product: "whatsapp", to: userId, text: { body: text },
          }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
        } catch (apiErr: any) {
          console.error("❌ MANUAL SEND ERROR:", apiErr.response?.data || apiErr.message);
        }
      }
      chat.messages.push({ role: 'model', text, timestamp: new Date() });
      chat.lastUpdated = new Date();
      await chat.save();
      res.json({ success: true, chat });
    } catch (error) {
      res.status(500).json({ error: "Failed to save manual response" });
    }
  });

  // --- Dynamic AI Knowledge ---
  let cachedServicesRaw: any[] = [];
  let lastServiceFetch = 0;

  async function resolveUserData(user: any) {
    if (!user) return null;
    const resolvedCars = await Promise.all((user.cars || []).map(async (car: any) => {
      let resolvedName = car.car_name;
      if (!resolvedName && car.id) {
        try {
          const modelData = await CarModel.findById(car.id);
          resolvedName = modelData?.carName || "Unknown Model";
        } catch (err) { /* silent */ }
      }
      return { ...car.toObject?.() || car, car_name: resolvedName || "Unknown Car" };
    }));
    const suggestedCar = resolvedCars.find((c: any) => c.primary)
      || resolvedCars.find((c: any) => c.status === '1')
      || resolvedCars.find((c: any) => c.status === 'active')
      || resolvedCars[0];
    const suggestedAddress = user.user_address?.find((a: any) => a.primary)
      || user.user_address?.find((a: any) => a.status === 'active')
      || user.user_address?.[0];
    return { ...user.toObject?.() || user, resolvedCars, suggestedCar, suggestedAddress };
  }

  // Resolve region ID from user's primary address, fallback to env
  function resolveRegionId(resolved: any): string {
    const regionId = resolved?.suggestedAddress?.region_id?.toString();
    return regionId || process.env.FALLBACK_REGION_ID || '';
  }

  // Get services with region+carType aware pricing
  async function getServicesForUser(regionId: string, carType: string): Promise<any[]> {
    if (!cachedServicesRaw.length || Date.now() - lastServiceFetch > 300000) {
      try {
        cachedServicesRaw = await Service.find({ status: '1' }).select('name pricing isPackage').lean();
        lastServiceFetch = Date.now();
      } catch (err) {
        console.error("Service fetch error:", err);
      }
    }
    const normalizedCarType = (carType || 'hatchback').toLowerCase();
    return cachedServicesRaw.map((svc: any) => {
      // Find price for this region and car type
      const regionPricing = svc.pricing?.find((p: any) => p.region?.toString() === regionId);
      const fallbackPricing = svc.pricing?.[0];
      const activePricing = regionPricing || fallbackPricing;
      const priceOption = activePricing?.price_options?.find((o: any) => o.carType === normalizedCarType)
        || activePricing?.price_options?.[0];
      const price = priceOption?.price;
      const discount = priceOption?.discount || 0;
      const finalPrice = price ? price - discount : null;
      return {
        _id: svc._id.toString(),
        name: svc.name,
        price: finalPrice,
        originalPrice: price,
        discount,
        carType: priceOption?.carType || normalizedCarType
      };
    }).filter((s: any) => s.price !== null);
  }

  // Get available slots for a date and region
  // Returns { slots: string[], actualDate: string } — actualDate may differ if nearest future date is used
  async function getAvailableSlots(regionId: string, dateStr: string): Promise<{ slots: string[]; actualDate: string }> {
    try {
      // Build query — validate ObjectId first to avoid cast errors
      const regionQuery: any = { date: dateStr, weeklyOff: { $ne: true } };
      if (regionId && mongoose.Types.ObjectId.isValid(regionId)) {
        regionQuery.region = new mongoose.Types.ObjectId(regionId);
      }

      let slotDoc = await AvailableSlots.findOne(regionQuery).lean() as any;

      // Fallback: try without region filter
      if (!slotDoc) {
        slotDoc = await AvailableSlots.findOne({ date: dateStr, weeklyOff: { $ne: true } }).lean() as any;
      }

      // If still nothing, find the nearest future date with slots
      if (!slotDoc) {
        console.log(`[Slots] No slots for ${dateStr}, looking for nearest future date...`);
        slotDoc = await AvailableSlots.findOne({
          date: { $gt: dateStr },
          weeklyOff: { $ne: true }
        }).sort({ date: 1 }).lean() as any;

        if (slotDoc) {
          console.log(`[Slots] Nearest available date: ${slotDoc.date}`);
        }
      }

      if (!slotDoc) {
        console.log(`[Slots] No slot docs found at all near ${dateStr}`);
        return { slots: [], actualDate: dateStr };
      }

      const available = (slotDoc.timeSlots || [])
        .filter((s: any) => !s.maxLimit || s.bookingCount < s.maxLimit)
        .map((s: any) => s.time);

      console.log(`[Slots] ${available.length} slots for ${slotDoc.date}: ${available.slice(0, 3).join(', ')}...`);
      return { slots: available, actualDate: slotDoc.date };
    } catch (err) {
      console.error('[Slots] Error fetching slots:', err);
      return { slots: [], actualDate: dateStr };
    }
  };

  async function getDynamicKnowledge(targetUserId: string, services?: any[]): Promise<string> {
    let userContext = "";
    let serviceContext = "";

    try {
      const cleanId = targetUserId.toString().replace(/\s+/g, '').replace('+', '');
      const isNumeric = /^\d+$/.test(cleanId);
      const query: any = { $or: [{ user_id: cleanId }] };
      if (isNumeric) {
        query.$or.push({ mobile_number: Number(cleanId) });
        if (cleanId.startsWith('91') && cleanId.length === 12) {
          query.$or.push({ mobile_number: Number(cleanId.substring(2)) });
        }
      }
      const user = await User.findOne(query);
      const resolved = await resolveUserData(user);

      if (resolved) {
        const primaryNote = resolved.suggestedCar ? ` (Suggesting ${resolved.suggestedCar.car_name} as primary)` : "";
        const carsList = resolved.resolvedCars?.length > 0
          ? resolved.resolvedCars.map((c: any) => `${c.car_name} [${c.car_type || 'hatchback'}]${c.primary ? ' [PRIMARY]' : ''}`).join(', ')
          : "None registered yet";
        const addrText = resolved.suggestedAddress
          ? `${resolved.suggestedAddress.tag}: ${resolved.suggestedAddress.address}${resolved.suggestedAddress.primary ? ' [PRIMARY]' : ''}`
          : "No address saved";
        const bookingCount = await Booking.countDocuments({ customer_id: resolved._id });
        const loyaltyLevel = bookingCount > 10 ? "VIP (Platinum)" : bookingCount > 3 ? "Regular (Gold)" : "New Friend";
        userContext = `
USER DATA:
- Registered Cars: ${carsList} ${primaryNote}
- Default Address: ${addrText}
- Past Bookings: ${bookingCount} orders
- Loyalty Status: ${loyaltyLevel}
PROMPT NOTE: Use the [PRIMARY] car/address. If VIP, treat them royally.`;
      }

      // Build services context from passed list (already fetched) or minimal fallback
      if (services && services.length > 0) {
        const shown = services.slice(0, 10);
        serviceContext = `AVAILABLE SERVICES (top ${shown.length} of ${services.length}, prices for ${resolved?.suggestedCar?.car_name || 'their car'}):\n`;
        serviceContext += shown.map((s, i) => `${i + 1}. ${s.name}: ₹${s.price}`).join('\n');
        if (services.length > 10) serviceContext += `\n(+${services.length - 10} more services available — user can ask "show more")`;
      } else {
        serviceContext = "AVAILABLE SERVICES: Fetch in progress. Tell user services are loading.";
      }
    } catch (err) {
      console.error("Dynamic knowledge error:", err);
    }

    return `${serviceContext}\n${userContext}`;
  }

  // --- Admin Token Manager (login once, auto-refresh before expiry) ---
  const adminTokenCache = { token: '', expiresAt: 0 };

  async function getAdminToken(): Promise<string> {
    const now = Date.now();
    // Refresh if expired or within 5 minutes of expiry
    if (adminTokenCache.token && now < adminTokenCache.expiresAt - 5 * 60 * 1000) {
      return adminTokenCache.token;
    }
    try {
      // CARMAA_BACKEND_URL = http://localhost:3001/api
      // Login route is /api/admin/auth/v1/login on the backend
      // So base (without /api) = http://localhost:3001
      const apiBase = process.env.CARMAA_BACKEND_URL || 'http://localhost:3001/api';
      const baseUrl = apiBase.replace(/\/api\/?$/, ''); // strip trailing /api
      const res = await axios.post(`${baseUrl}/api/admin/auth/v1/login`, {
        email: process.env.CARMAA_ADMIN_EMAIL,
        password: process.env.CARMAA_ADMIN_PASSWORD
      });
      const token = res.data?.result?.accessToken;
      if (!token) throw new Error('No token in login response: ' + JSON.stringify(res.data));
      adminTokenCache.token = token;
      adminTokenCache.expiresAt = now + 60 * 60 * 1000; // 1 hour
      console.log('[AdminToken] 🔑 Fetched fresh admin token');
      return token;
    } catch (err: any) {
      console.error('[AdminToken] ❌ Login failed:', err.response?.data || err.message);
      throw new Error('Failed to get admin token: ' + (err.response?.data?.msg || err.message));
    }
  }

  // Pre-fetch admin token at startup
  getAdminToken().catch(err => console.error('[AdminToken] Startup prefetch failed:', err.message));

  // --- Create Booking via Admin API ---
  async function createBookingViaAPI(draft: any, user: any): Promise<{ success: boolean; bookingId?: string; error?: string }> {
    try {
      const token = await getAdminToken();
      const carType = (user.suggestedCar?.car_type || 'hatchback').toLowerCase();
      const addr = user.suggestedAddress;
      
      const payload = {
        customer_id: user._id.toString(),
        time: draft.time,
        type: "onetime",
        date: draft.date,
        address: {
          tag: addr?.tag || "Home",
          address: addr?.address || "",
          pincode: String(addr?.pincode || ""),
        },
        payment: {
          price: String(draft.price || "0"),
          discount: String(draft.discount || "0"),
          method: "cash",
          paid: "0",
          paidOn: "",
          transaction_id: "",
          status: "pending",
          other_charges: []
        },
        totalCoins: 0,
        coinHistory: [],
        booked_services: [
          {
            vehicle: user.suggestedCar?.id?.toString() || "",
            user_vehicle_id: user.suggestedCar?._id?.toString() || "",
            services: [
              {
                id: draft.serviceId,
                addOns: [],
                price: String(draft.price || "0"),
                discount: String(draft.discount || "0")
              }
            ]
          }
        ],
        serviceNames: [draft.serviceName]
      };

      const backendUrl = process.env.CARMAA_BACKEND_URL || 'https://app.carmaacarcare.com/api';
      const response = await axios.post(
        `${backendUrl}/admin/v1/create-booking`,
        payload,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );

      if (response.data?.status || response.data?.result?._id) {
        return { success: true, bookingId: response.data?.result?._id };
      }
      return { success: false, error: response.data?.error || "Unknown error from booking API" };
    } catch (err: any) {
      console.error("❌ Booking API error:", err.response?.data || err.message);
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  // --- WhatsApp Interactive Message Senders ---
  async function sendWhatsAppText(to: string, phoneId: string, body: string) {
    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to,
      text: { body }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  }

  // Abbreviate service name to fit WhatsApp's 24-char row title limit
  function abbreviateServiceName(name: string): string {
    if (name.length <= 24) return name;
    // Try common abbreviations first
    const abbreviated = name
      .replace(/Premium/gi, 'Prem.')
      .replace(/Interior/gi, 'Int.')
      .replace(/Exterior/gi, 'Ext.')
      .replace(/Detailing/gi, 'Detail')
      .replace(/Cleaning/gi, 'Clean')
      .replace(/Ceramic/gi, 'Cerm.')
      .replace(/Protection/gi, 'Prot.')
      .replace(/Polishing/gi, 'Polish')
      .replace(/Treatment/gi, 'Treat.')
      .replace(/Package/gi, 'Pkg')
      .replace(/Service/gi, 'Svc');
    if (abbreviated.length <= 24) return abbreviated;
    // Hard truncate with ellipsis as last resort
    return abbreviated.slice(0, 21) + '...';
  }

  async function sendWhatsAppServiceList(to: string, phoneId: string, services: any[], startIndex = 0) {
    const chunk = services.slice(startIndex, startIndex + 10);
    const hasMore = services.length > startIndex + 10;

    const rows = chunk.map(s => ({
      id: `svc_${s._id}`,
      title: abbreviateServiceName(s.name), // Abbreviated to fit WA 24-char limit
      description: `₹${s.price}${s.discount > 0 ? ` (₹${s.discount} off!)` : ''} — ${s.name.slice(0, 40)}`
    }));

    const bodyText = startIndex === 0
      ? `Yeh raha menu bhai! 🚗✨ (${services.length} services available)`
      : `Aur bhi hain! Dekho (${startIndex + 1}–${startIndex + chunk.length} of ${services.length}):`;

    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "🧼 Carmaa Services Menu" },
        body: { text: bodyText },
        footer: { text: hasMore ? `Showing ${startIndex + 1}–${startIndex + chunk.length} of ${services.length}` : "Carmaa — Premium Car Care 🔥" },
        action: {
          button: "Choose Service",
          sections: [{ title: "Available Services", rows }]
        }
      }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });

    // If more services exist, send a follow-up button widget so user can tap to see more
    if (hasMore) {
      await new Promise(r => setTimeout(r, 800)); // Small delay so messages appear in order
      await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: `Aur bhi ${services.length - startIndex - chunk.length} services hain! 👇` },
          action: {
            buttons: [
              { type: "reply", reply: { id: "show_more_services", title: "See More Services" } }
            ]
          }
        }
      }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    }
  }

  async function sendWhatsAppSlotButtons(to: string, phoneId: string, slots: string[], dateStr: string) {
    const displayed = slots.slice(0, 3);
    const dateDisplay = formatDateDisplay(dateStr);

    if (displayed.length === 0) {
      await sendWhatsAppText(to, phoneId, `Bhai, ${dateDisplay} ke liye koi slot available nahi hai. Koi aur din try karo? 🙏`);
      return;
    }

    const buttons = displayed.map(t => ({
      type: "reply",
      reply: { id: `slot_${t}`, title: t }
    }));

    let bodyText = `📅 *${dateDisplay}* ke available slots:\n\nKaunsa time suit karega? 🕐`;
    if (slots.length > 3) bodyText += `\n\n(+${slots.length - 3} more slots available)`;

    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons }
      }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  }

  async function sendWhatsAppConfirmation(to: string, phoneId: string, draft: any, user: any) {
    const dateDisplay = formatDateDisplay(draft.date);
    const carName = user?.suggestedCar?.car_name || "your car";
    const addr = user?.suggestedAddress?.address || "your address";

    const summary = `✅ *Booking Summary*\n\n🚗 *Car:* ${carName}\n🧼 *Service:* ${draft.serviceName}\n💰 *Price:* ₹${draft.price}\n📅 *Date:* ${dateDisplay}\n⏰ *Time:* ${draft.time}\n📍 *Address:* ${addr}\n\n*Confirm karna hai?* 🔥`;

    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: summary },
        action: {
          buttons: [
            { type: "reply", reply: { id: "confirm_booking", title: "✅ Confirm" } },
            { type: "reply", reply: { id: "cancel_booking", title: "❌ Cancel" } }
          ]
        }
      }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  }

  // --- Gemini Setup ---
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  const CARMAA_CONTEXT = `
    You are "Carmaa Bro", the chillest AI Sales Rep for Carmaa (premium door-to-door car service in India).
    
    Vibe:
    - Informal, humorous, slightly "Instagram-y". 
    - Use Hinglish (mix of Hindi and English) naturally.
    - Be witty but helpful. No "robotic" corporate speak.
    - Use emojis like 🚗✨🧼🔥.
    - Treat the user like a friend — goal is BOOKING.
    - Keep it SHORT. WhatsApp users don't read essays.
    
    BOOKING FLOW RULES (follow strictly):
    1. When user wants to book → say you'll show them the services menu (the system will send a widget automatically).
    2. After service selected → ask WHEN they want it. Keep it casual: "Kab chahiye bro?"
    3. After date given → confirm the date back to user ("Okay, [date] ke liye slot dhundta hoon!") — system handles slot widget.
    4. After slot selected → system will show confirmation — just stay ready.
    5. After confirmed → celebrate! "Booking ho gayi bhai! 🎉"
    6. After cancelled → "No problem! Jab bhi ready ho, batao." and reset.
    
    SERVICES DISPLAY RULES:
    - Show prices only when relevant to the conversation or if asked.
    - If asked to show all/more services → acknowledge ("Haan bhai, sab dikhata hoon!"), system handles the widget.
    - Never list all services as plain text if you can use the widget.
    
    PERSONALITY RULES:
    - Don't repeat yourself or the user's message.
    - Never say "I'm an AI" — you're Carmaa Bro, a human-feeling rep.
    - If price is asked, give it with a joke or fun comment.
    - If they hesitate, say "Gaadi gandi acchi nahi lagti bro!"
    
    Offers:
    - First booking? CARMAA20 for 20% off. "Pehli baar, toh discount banta hai!"
    - Refer a friend? ₹200 off. "Dost ka bhala, aapka bhi bhala."
  `;

  // --- Webhook ---
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (!mode && !token) return res.status(200).send("Carmaa Webhook is LIVE.");
    const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || "carmaa_secret").trim();
    if (mode === "subscribe" && token === expectedToken) return res.status(200).send(challenge);
    return res.status(403).send("Verification failed");
  });

  app.post("/webhook", async (req, res) => {
    const body = req.body;
    webhookLogs.push({ time: new Date().toISOString(), method: "POST", body });
    if (webhookLogs.length > 50) webhookLogs.shift();

    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0]?.changes?.[0]?.value;
      if (entry?.messages?.[0]) {
        const phone_number_id = entry.metadata.phone_number_id;
        const msg = entry.messages[0];
        const from = msg.from;
        const mid = msg.id;

        // Deduplication
        if (processedMids.has(mid)) {
          console.log(`[${new Date().toLocaleTimeString()}] ♻️  Ignoring duplicate: ${mid}`);
          return res.sendStatus(200);
        }
        processedMids.set(mid, Date.now());
        res.sendStatus(200);

        // Parse message — handle both text and interactive replies
        let msg_text = "";
        if (msg.type === 'text') {
          msg_text = msg.text?.body || "";
        } else if (msg.type === 'interactive') {
          const interactive = msg.interactive;
          if (interactive?.type === 'button_reply') {
            msg_text = interactive.button_reply.id; // e.g. "slot_10:00 AM", "confirm_booking"
          } else if (interactive?.type === 'list_reply') {
            msg_text = interactive.list_reply.id;   // e.g. "svc_67ea2cbe78a4f9b7c05f0406"
          }
        }

        (async () => {
          try {
            await handleMessage(from, msg_text, 'whatsapp', phone_number_id);
          } catch (err) {
            console.error("Async Process Error:", err);
          }
        })();
        return;
      }
      return res.sendStatus(200);
    }

    if (body.object === "page" || body.object === "instagram") {
      const entry = body.entry?.[0]?.messaging?.[0];
      if (entry?.message) {
        const senderId = entry.sender.id;
        const msg_text = entry.message.text || "";
        const mid = entry.message.mid;
        const platform = body.object === "instagram" ? "instagram" : "messenger";
        if (processedMids.has(mid)) return res.sendStatus(200);
        processedMids.set(mid, Date.now());
        res.sendStatus(200);
        (async () => {
          try { await handleMessage(senderId, msg_text, platform); }
          catch (err) { console.error("Async Process Error:", err); }
        })();
        return;
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

  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  // ============================================================
  //  CORE MESSAGE HANDLER
  // ============================================================
  async function handleMessage(userId: string, text: string, platform: string, phoneId?: string): Promise<string> {
    const cacheKey = `${platform}:${userId}`;
    const isWhatsApp = platform === 'whatsapp' && !!phoneId;

    try {
      // 1. Resolve user identity for context
      const cleanId = userId.toString().replace(/\s+/g, '').replace('+', '');
      const isNumeric = /^\d+$/.test(cleanId);
      const userQuery: any = { $or: [{ user_id: cleanId }] };
      if (isNumeric) {
        userQuery.$or.push({ mobile_number: Number(cleanId) });
        if (cleanId.startsWith('91') && cleanId.length === 12) {
          userQuery.$or.push({ mobile_number: Number(cleanId.substring(2)) });
        }
      }
      const dbUser = await User.findOne(userQuery);
      const resolved = await resolveUserData(dbUser);
      const regionId = resolveRegionId(resolved);
      const carType = resolved?.suggestedCar?.car_type || 'hatchback';

      // 2. Load chat history
      let messages = contextCache.get(cacheKey) || [];
      if (messages.length === 0) {
        const chat = await Chat.findOne({ userId, platform });
        if (chat) messages = [...(chat.messages || [])];
      }

      const timestamp = new Date();
      console.log(`\n[${timestamp.toLocaleTimeString()}] 📥 INCOMING [${platform}] from ${userId}: "${text}"`);

      // 3. Load booking draft
      let draft = bookingDrafts.get(cacheKey) || { step: 'idle' };

      // ── Interactive Reply Handling ─────────────────────────────────────────
      // Handle WhatsApp button/list replies before sending to AI
      let interactiveHandled = false;
      let systemMessage = "";

      if (text === 'show_more_services') {
        // User tapped the "See More Services" button
        const allServices = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
        userServiceCache.set(cacheKey, allServices);
        const currentOffset = (draft.serviceOffset || 0) + 10;
        if (isWhatsApp && allServices.length > currentOffset) {
          await sendWhatsAppServiceList(userId, phoneId!, allServices, currentOffset);
          draft = { ...draft, step: 'picking_service', serviceOffset: currentOffset };
          bookingDrafts.set(cacheKey, draft);
        } else if (isWhatsApp) {
          await sendWhatsAppText(userId, phoneId!, 'Bhai yeh sab services hain humari! Ab choose karo 😄');
        }
        messages.push({ role: 'user', text, timestamp });
        const ackText = `Showing services ${currentOffset + 1}–${Math.min(currentOffset + 10, allServices.length)} of ${allServices.length}`;
        messages.push({ role: 'model', text: ackText, timestamp: new Date() });
        contextCache.set(cacheKey, messages.slice(-20));
        persistChat(userId, platform, messages);
        return ackText;
      }

      if (text.startsWith('svc_')) {
        // User picked a service from list — return early, no AI needed
        const serviceId = text.replace('svc_', '');
        const allServices = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
        const selectedService = allServices.find((s: any) => s._id === serviceId);
        if (selectedService) {
          draft = {
            ...draft,
            step: 'picking_date',
            serviceId: selectedService._id,
            serviceName: selectedService.name,
            price: selectedService.price,
            discount: selectedService.discount || 0,
            serviceOffset: 0
          };
          bookingDrafts.set(cacheKey, draft);
          const reply = `Perfect choice bhai! 🔥 *${selectedService.name}* (₹${selectedService.price}) lock kar lete hain.\n\nKab chahiye? Today, tomorrow, ya koi specific date batao? 📅`;
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: reply, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, reply);
          return reply;
        }
        // Service not found — fall through to AI
        interactiveHandled = true;
      } else if (text.startsWith('slot_')) {
        // User picked a time slot
        const time = text.replace('slot_', '');
        draft = { ...draft, step: 'confirming', time };
        bookingDrafts.set(cacheKey, draft);

        if (isWhatsApp && resolved) {
          await sendWhatsAppConfirmation(userId, phoneId!, draft, resolved);
          const confirmMsg = `System sent confirmation widget for: ${draft.serviceName} on ${formatDateDisplay(draft.date)} at ${time}.`;
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: confirmMsg, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return confirmMsg;
        }
        systemMessage = `User picked time slot: ${time}. Show them a confirmation summary and ask to confirm.`;
        interactiveHandled = true;

      } else if (text === 'confirm_booking') {
        // User confirmed booking
        if (draft.step === 'confirming' && draft.serviceId && draft.date && draft.time && resolved) {
          const result = await createBookingViaAPI(draft, resolved);
          if (result.success) {
            const successText = `🎉 Ho gayi booking bhai!\n\n✅ *${draft.serviceName}*\n📅 ${formatDateDisplay(draft.date)}\n⏰ ${draft.time}\n\nOur team will reach you on time. Gaadi chamakne wali hai! 🚗✨`;
            if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, successText);
            bookingDrafts.delete(cacheKey);
            messages.push({ role: 'user', text: 'confirm_booking', timestamp });
            messages.push({ role: 'model', text: successText, timestamp: new Date() });
            contextCache.set(cacheKey, messages.slice(-20));
            persistChat(userId, platform, messages);
            console.log(`[${new Date().toLocaleTimeString()}] ✅ BOOKING CONFIRMED for ${userId}`);
            return successText;
          } else {
            const errText = `Bhai, kuch technical issue hua! 😅 Please call us directly or try again in a bit. Error: ${result.error}`;
            if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, errText);
            return errText;
          }
        }
        systemMessage = "User wants to confirm booking but details are incomplete. Ask them to restart the booking flow.";
        interactiveHandled = true;

      } else if (text === 'cancel_booking') {
        bookingDrafts.delete(cacheKey);
        const cancelText = "No problem bhai! Jab bhi gaadi chamkani ho, batao. Main hoon! 🚗";
        if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, cancelText);
        messages.push({ role: 'user', text: 'cancel_booking', timestamp });
        messages.push({ role: 'model', text: cancelText, timestamp: new Date() });
        contextCache.set(cacheKey, messages.slice(-20));
        persistChat(userId, platform, messages);
        return cancelText;
      }

      // ── Date Detection ─────────────────────────────────────────────────────
      if (!interactiveHandled && (draft.step === 'picking_date' || text.match(/today|tomorrow|kal|aaj|parso|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})/i))) {
        const parsedDate = parseUserDate(text);
        if (parsedDate && draft.step === 'picking_date') {

          // Fetch slots — may return a different (nearest) date if parsedDate has no slots
          const { slots, actualDate } = await getAvailableSlots(regionId, parsedDate);

          const dateChanged = actualDate !== parsedDate;
          draft = { ...draft, step: 'picking_slot', date: actualDate };
          bookingDrafts.set(cacheKey, draft);

          if (isWhatsApp) {
            if (dateChanged) {
              // Date was shifted to nearest available — tell user
              await sendWhatsAppText(userId, phoneId!,
                `Bhai, ${formatDateDisplay(parsedDate)} ke liye koi slot nahi hai. ` +
                `Nearest available date hai *${formatDateDisplay(actualDate)}* — yeh dekho! 📅`
              );
            } else {
              await sendWhatsAppText(userId, phoneId!, `Okay! ${formatDateDisplay(actualDate)} ke liye slot dhundta hoon... 🔍`);
            }
            await sendWhatsAppSlotButtons(userId, phoneId!, slots, actualDate);
          }

          const slotMsg = slots.length > 0
            ? `Available slots for ${actualDate}: ${slots.join(', ')}`
            : `No slots available anywhere near ${parsedDate}. Ask user to contact support or check back later.`;
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: slotMsg, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return slotMsg;
        }
      }


      // ── Fetch Services & Send Widget ───────────────────────────────────────
      const wantsServices = /service|book|wash|clean|detail|menu|what.*offer|kya.*milega|packages?|show more|aur.*dikhao|more service/i.test(text);
      const wantsMoreServices = /^(more|aur dikhao|aur batao|baaki|remaining|show more|next)$/i.test(text.trim());

      if (wantsServices || wantsMoreServices) {
        const allServices = await getServicesForUser(regionId, carType);
        userServiceCache.set(cacheKey, allServices);

        if (isWhatsApp && allServices.length > 0) {
          // Track offset: 'more' advances by 10, fresh request resets to 0
          const currentOffset = (wantsMoreServices && !wantsServices) ? (draft.serviceOffset || 0) + 10 : 0;
          await sendWhatsAppServiceList(userId, phoneId!, allServices, currentOffset);
          draft = { ...draft, step: 'picking_service', serviceOffset: currentOffset };
          bookingDrafts.set(cacheKey, draft);

          // If 'more' was the only trigger, send a text ack and return — no AI text needed
          if (wantsMoreServices && !wantsServices) {
            const ackText = `Yeh lo aur bhi options! 👇 (${currentOffset + 1}–${Math.min(currentOffset + 10, allServices.length)} of ${allServices.length})`;
            messages.push({ role: 'user', text, timestamp });
            messages.push({ role: 'model', text: ackText, timestamp: new Date() });
            contextCache.set(cacheKey, messages.slice(-20));
            persistChat(userId, platform, messages);
            return ackText;
          }
        }
      }

      // ── AI Response Generation ─────────────────────────────────────────────
      const start = performance.now();
      
      // Fetch services for context (use cached if available)
      const servicesForContext = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
      if (!userServiceCache.has(cacheKey)) userServiceCache.set(cacheKey, servicesForContext);

      const dataStart = performance.now();
      const dynamicKnowledge = await getDynamicKnowledge(userId, servicesForContext);
      const dataDuration = ((performance.now() - dataStart) / 1000).toFixed(2);

      // Build draft state context for AI
      const draftContext = draft.step !== 'idle' ? `
CURRENT BOOKING DRAFT:
- Step: ${draft.step}
- Service: ${draft.serviceName || 'not selected'} (₹${draft.price || '?'})
- Date: ${draft.date || 'not selected'}
- Time: ${draft.time || 'not selected'}
` : '';

      // Add to history — use systemMessage if interactive was handled
      const userText = interactiveHandled ? systemMessage : text;
      messages.push({ role: "user", text: interactiveHandled ? text : text, timestamp });

      const history = messages.slice(-10).map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }]
      }));

      const aiStart = performance.now();
      const response = await genAI.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
        contents: history,
        config: {
          systemInstruction: CARMAA_CONTEXT + "\n\n" + dynamicKnowledge + draftContext
            + (interactiveHandled ? `\n\nSYSTEM NOTE: ${systemMessage}` : '')
        },
      });
      const aiDuration = ((performance.now() - aiStart) / 1000).toFixed(2);

      const aiResponse = response.text || "Bro, server thoda slow hai, ek min ruko!";
      const totalDuration = ((performance.now() - start) / 1000).toFixed(2);

      console.log(`[${new Date().toLocaleTimeString()}] 📤 OUTGOING [${platform}] to ${userId}: "${aiResponse.slice(0, 60)}..."`);
      console.log(`   ⏱️  Data: ${dataDuration}s | AI: ${aiDuration}s | Total: ${totalDuration}s`);

      messages.push({ role: "model", text: aiResponse, timestamp: new Date() });
      contextCache.set(cacheKey, messages.slice(-20));
      persistChat(userId, platform, messages);

      // Send AI reply via WhatsApp
      if (isWhatsApp) {
        await sendWhatsAppText(userId, phoneId!, aiResponse);
      }

      return aiResponse;

    } catch (error: any) {
      if (error.response?.status === 401) {
        console.error("❌ WHATSAPP ERROR: Token Expired");
      } else {
        console.error("Error in handleMessage:", error.message || error);
      }
      return "Sorry bro, kuch toh gadbad hai! Thoda wait karo. 🙏";
    }
  }

  // Background DB persistence
  function persistChat(userId: string, platform: string, messages: any[]) {
    const cacheKey = `${platform}:${userId}`;
    (async () => {
      const { score, reason } = calculateLeadScore(messages);
      await Chat.findOneAndUpdate(
        { userId, platform },
        { $set: { messages, leadScore: score, scoreReason: reason, lastUpdated: new Date() } },
        { upsert: true }
      );
    })().catch(err => console.error("DB Update Error:", err));
  }

  // --- Website Widget Script ---
  app.get("/widget.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(`
      (function() {
        const API_BASE = window.location.origin;
        const initWidget = () => {
          if (document.getElementById('carmaa-chat-widget')) return;
          const config = window.CarmaaAIConfig || { themeColor: '#ea580c', title: 'Carmaa Bro 🚗' };
          const div = document.createElement('div');
          div.id = 'carmaa-chat-widget';
          div.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;font-family:sans-serif;';
          div.innerHTML = \`
            <button id="carmaa-toggle" style="background:\${config.themeColor};color:#fff;border:none;padding:15px 25px;border-radius:50px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2);font-weight:bold;display:flex;align-items:center;gap:10px;">
              <span>Chat with Carmaa Bro</span> 🚗
            </button>
            <div id="carmaa-box" style="display:none;width:350px;height:500px;background:#fff;border:1px solid #eee;border-radius:20px;margin-bottom:15px;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.15);overflow:hidden;">
              <div style="padding:20px;background:\${config.themeColor};color:#fff;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
                <span>\${config.title}</span>
                <button id="carmaa-close" style="background:none;border:none;color:#fff;cursor:pointer;font-size:20px;">&times;</button>
              </div>
              <div id="carmaa-msgs" style="flex:1;overflow-y:auto;padding:20px;background:#f9f9f9;display:flex;flex-direction:column;gap:10px;">
                <div style="text-align:left;"><span style="background:#fff;border:1px solid #eee;padding:10px 14px;border-radius:18px;border-bottom-left-radius:4px;display:inline-block;max-width:85%;font-size:14px;line-height:1.4;">Namaste! Carmaa Bro here. Gaadi chamkani hai? 🔥</span></div>
              </div>
              <div id="carmaa-typing" style="display:none;padding:5px 20px;font-size:12px;color:#999;">Bro is typing...</div>
              <div style="padding:15px;border-top:1px solid #eee;display:flex;gap:8px;background:#fff;">
                <input id="carmaa-input" type="text" placeholder="Type a message..." style="flex:1;border:1px solid #ddd;padding:10px 15px;border-radius:25px;outline:none;font-size:14px;">
                <button id="carmaa-send" style="background:\${config.themeColor};color:#fff;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:bold;">&rarr;</button>
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
            msgDiv.innerHTML = \`<span style="background:\${isUser ? config.themeColor : '#fff'};color:\${isUser ? '#fff' : '#333'};border:\${isUser ? 'none' : '1px solid #eee'};padding:10px 14px;border-radius:18px;\${isUser ? 'border-bottom-right-radius:4px' : 'border-bottom-left-radius:4px'};display:inline-block;max-width:85%;font-size:14px;line-height:1.4;">\${text}</span>\`;
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
        if (document.readyState === 'complete') initWidget();
        else window.addEventListener('load', initWidget);
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
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Carmaa AI Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
