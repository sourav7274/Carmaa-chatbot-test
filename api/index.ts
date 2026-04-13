import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import axios from "axios";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cors from "cors";

// Fixed relative paths because this file is now in the /api folder
import { Chat } from "../models/Chat.js";
import { User } from "../models/User.js";
import { Service } from "../models/Service.js";
import { Booking } from "../models/Booking.js";
import { CarModel } from "../models/CarModel.js";
import { AvailableSlots } from "../models/AvailableSlots.js";
import { City } from "../models/City.js";
import { Prerequisites } from "../models/Prerequisites.js";
import { WhatIncludes } from "../models/WhatIncludes.js";

dotenv.config();

// Fix __dirname to point to the root from the /api folder
const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- MongoDB Setup ---
const MONGODB_URI = process.env.MONGODB_URI;
async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  try {
    if (!MONGODB_URI) {
      console.error("❌ MONGODB_URI is missing in environment!");
      return;
    }
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}


// --- In-Memory Caches ---
const contextCache = new Map<string, any[]>();
const processedMids = new Map<string, number>();
const bookingDrafts = new Map<string, any>();
const userServiceCache = new Map<string, any[]>();

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
function parseUserDate(text: string, inDateSelection = false): string | null {
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

  const iso = lower.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const monthNames: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  const dateMatch = lower.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const monthWord = dateMatch[2];
    const month = monthNames[monthWord];
    if (month !== undefined) {
      const year = now.getMonth() > month ? now.getFullYear() + 1 : now.getFullYear();
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  if (inDateSelection) {
    const bareDay = lower.match(/^(\d{1,2})(?:\s|$|\?|ko|ki|ka|ke|th|st|nd|rd)/);
    if (bareDay) {
      const day = parseInt(bareDay[1]);
      if (day >= 1 && day <= 31) {
        const now2 = new Date();
        let month = now2.getMonth();
        let year = now2.getFullYear();
        if (day <= now2.getDate()) {
          month++;
          if (month > 11) { month = 0; year++; }
        }
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  return null;
}

function isDateInPast(dateStr: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return d < today;
}

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  let webhookLogs: any[] = [];

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString(), logs: webhookLogs.slice(-10) });
  });

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

  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await Chat.aggregate([{ $group: { _id: "$platform", count: { $sum: 1 } } }]);
      const distribution = stats.reduce((acc: any, curr: any) => { acc[curr._id] = curr.count; return acc; }, {});
      res.json(distribution);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

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

  function resolveRegionId(resolved: any): string {
    const regionId = resolved?.suggestedAddress?.region_id?.toString();
    return regionId || process.env.FALLBACK_REGION_ID || '';
  }

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

  async function getServiceDetails(serviceId: string, regionId: string): Promise<any | null> {
    try {
      const service = await Service.findById(serviceId).lean();
      if (!service) return null;
      const normalizedCarType = 'hatchback';
      const regionPricing = service.pricing?.find((p: any) => p.region?.toString() === regionId);
      const fallbackPricing = service.pricing?.[0];
      const activePricing = regionPricing || fallbackPricing;
      const priceOption = activePricing?.price_options?.find((o: any) => o.carType === normalizedCarType)
        || activePricing?.price_options?.[0];

      let prerequisites: string[] = [];
      if (service.prerequisites && service.prerequisites.length > 0) {
        const prereqDocs = await Prerequisites.find({ _id: { $in: service.prerequisites } }).lean();
        prerequisites = prereqDocs.map((p: any) => p.title).filter(Boolean);
      }
      let whatIncludes: string[] = [];
      if (service.whatIncludes && service.whatIncludes.length > 0) {
        const whatIncludesDocs = await WhatIncludes.find({ _id: { $in: service.whatIncludes } }).lean();
        whatIncludes = whatIncludesDocs.map((w: any) => w.title).filter(Boolean);
      }
      return {
        _id: service._id.toString(),
        name: service.name,
        price: priceOption?.price || null,
        discount: priceOption?.discount || 0,
        finalPrice: priceOption?.price ? priceOption.price - (priceOption.discount || 0) : null,
        time: service.time || '2-3 hours',
        whatIncludes,
        prerequisites,
        details: service.details || [],
        not_included: service.not_included || []
      };
    } catch (err) {
      console.error("Error fetching service details:", err);
      return null;
    }
  }

  async function getAvailableSlots(regionId: string, dateStr: string): Promise<{ slots: string[]; actualDate: string }> {
    try {
      const regionQuery: any = { date: dateStr, weeklyOff: { $ne: true } };
      if (regionId && mongoose.Types.ObjectId.isValid(regionId)) {
        regionQuery.region = new mongoose.Types.ObjectId(regionId);
      }
      let slotDoc = await AvailableSlots.findOne(regionQuery).lean() as any;
      if (!slotDoc) slotDoc = await AvailableSlots.findOne({ date: dateStr, weeklyOff: { $ne: true } }).lean() as any;
      if (!slotDoc) {
        slotDoc = await AvailableSlots.findOne({ date: { $gt: dateStr }, weeklyOff: { $ne: true } }).sort({ date: 1 }).lean() as any;
      }
      if (!slotDoc) return { slots: [], actualDate: dateStr };
      let available: string[] = (slotDoc.timeSlots || [])
        .filter((s: any) => !s.maxLimit || s.bookingCount < s.maxLimit)
        .map((s: any) => s.time);
      const today = new Date().toISOString().split('T')[0];
      if (slotDoc.date === today) {
        const now = new Date();
        const cutoff = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const cutoffH = cutoff.getHours(), cutoffM = cutoff.getMinutes();
        available = available.filter(slotTime => {
          const startPart = slotTime.split('-')[0]?.trim();
          const match = startPart?.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (!match) return false;
          let h = parseInt(match[1]); const m = parseInt(match[2]); const period = match[3].toUpperCase();
          if (period === 'PM' && h !== 12) h += 12;
          if (period === 'AM' && h === 12) h = 0;
          return h > cutoffH || (h === cutoffH && m >= cutoffM);
        });
      }
      return { slots: available, actualDate: slotDoc.date };
    } catch (err) {
      console.error('[Slots] Error:', err);
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
        if (cleanId.startsWith('91') && cleanId.length === 12) query.$or.push({ mobile_number: Number(cleanId.substring(2)) });
      }
      const user = await User.findOne(query);
      const resolved = await resolveUserData(user);
      if (resolved) {
        const carsList = resolved.resolvedCars?.length > 0 ? resolved.resolvedCars.map((c: any) => `${c.car_name} [${c.car_type || 'hatchback'}]${c.primary ? ' [PRIMARY]' : ''}`).join(', ') : "None";
        const addrText = resolved.suggestedAddress ? `${resolved.suggestedAddress.tag}: ${resolved.suggestedAddress.address}` : "No address";
        const bookingCount = await Booking.countDocuments({ customer_id: resolved._id });
        userContext = `\nUSER DATA:\n- Registered Cars: ${carsList}\n- Default Address: ${addrText}\n- Past Bookings: ${bookingCount}`;
      }
      if (services && services.length > 0) {
        const shown = services.slice(0, 10);
        serviceContext = `AVAILABLE SERVICES (prices for ${resolved?.suggestedCar?.car_name || 'their car'}):\n` + shown.map((s, i) => `${i + 1}. ${s.name}: ₹${s.price}`).join('\n');
      }
    } catch (err) {}
    return `${serviceContext}\n${userContext}`;
  }

  const adminTokenCache = { token: '', expiresAt: 0 };
  async function getAdminToken(): Promise<string> {
    const now = Date.now();
    if (adminTokenCache.token && now < adminTokenCache.expiresAt - 5 * 60 * 1000) return adminTokenCache.token;
    try {
      const apiBase = process.env.CARMAA_BACKEND_URL || 'https://app.carmaacarcare.com/api';
      const baseUrl = apiBase.replace(/\/api\/?$/, '');
      const res = await axios.post(`${baseUrl}/api/admin/auth/v1/login`, {
        email: process.env.CARMAA_ADMIN_EMAIL, password: process.env.CARMAA_ADMIN_PASSWORD
      });
      const token = res.data?.result?.accessToken;
      if (!token) throw new Error('No token');
      adminTokenCache.token = token; adminTokenCache.expiresAt = now + 60 * 60 * 1000;
      return token;
    } catch (err: any) { throw new Error('Admin login failed'); }
  }

  async function createBookingViaAPI(draft: any, user: any): Promise<{ success: boolean; bookingId?: string; error?: string }> {
    try {
      const token = await getAdminToken();
      const addr = user.suggestedAddress;
      const payload = {
        customer_id: user._id.toString(), time: draft.time, type: "onetime", date: draft.date,
        address: { tag: addr?.tag || "Home", address: addr?.address || "", pincode: String(addr?.pincode || "") },
        payment: { price: String(draft.price || "0"), discount: String(draft.discount || "0"), method: "cash", paid: "0", status: "pending", other_charges: [] },
        booked_services: [{ vehicle: user.suggestedCar?.id?.toString() || "", user_vehicle_id: user.suggestedCar?._id?.toString() || "", services: [{ id: draft.serviceId, addOns: [], price: String(draft.price || "0"), discount: String(draft.discount || "0") }] }],
        serviceNames: [draft.serviceName]
      };
      const backendUrl = process.env.CARMAA_BACKEND_URL || 'https://app.carmaacarcare.com/api';
      const response = await axios.post(`${backendUrl}/admin/v1/create-booking`, payload, { headers: { Authorization: `Bearer ${token}` } });
      if (response.data?.status || response.data?.result?._id) return { success: true, bookingId: response.data?.result?._id };
      return { success: false, error: "API error" };
    } catch (err: any) { return { success: false, error: err.message }; }
  }

  async function sendWhatsAppText(to: string, phoneId: string, body: string) {
    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, { messaging_product: "whatsapp", to, text: { body } }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  }

  function abbreviateServiceName(name: string): string {
    if (name.length <= 24) return name;
    return name.replace(/Premium/gi, 'Prem.').replace(/Interior/gi, 'Int.').replace(/Exterior/gi, 'Ext.').replace(/Cleaning/gi, 'Clean').replace(/Service/gi, 'Svc').slice(0, 21) + '...';
  }

  async function sendWhatsAppServiceList(to: string, phoneId: string, services: any[], startIndex = 0) {
    const chunk = services.slice(startIndex, startIndex + 10);
    const hasMore = services.length > startIndex + 10;
    const rows = chunk.map(s => ({ id: `svc_${s._id}`, title: abbreviateServiceName(s.name), description: `₹${s.price}${s.discount > 0 ? ` (₹${s.discount} off!)` : ''}` }));
    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: { type: "list", header: { type: "text", text: "Carmaa Menu" }, body: { text: "Kaunsi service book karni hai?" }, action: { button: "Choose Service", sections: [{ title: "Services", rows }] } }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    if (hasMore) {
      await new Promise(r => setTimeout(r, 800));
      await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text: "Aur bhi services hain!" }, action: { buttons: [{ type: "reply", reply: { id: "show_more_services", title: "See More" } }] } } }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    }
  }

  async function sendWhatsAppServiceInfoList(to: string, phoneId: string, services: any[], startIndex = 0) {
    const chunk = services.slice(startIndex, startIndex + 10);
    const hasMore = services.length > startIndex + 10;
    const rows = chunk.map(s => ({ id: `svc_info_${s._id}`, title: abbreviateServiceName(s.name), description: `₹${s.price} — Tap for details` }));
    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: { type: "list", header: { type: "text", text: "Details Menu" }, body: { text: "Details ke liye service select kijiye:" }, action: { button: "View Details", sections: [{ title: "Services", rows }] } }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    if (hasMore) {
      await new Promise(r => setTimeout(r, 800));
      await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text: "Baaki services ke details:" }, action: { buttons: [{ type: "reply", reply: { id: "show_more_info_services", title: "See More Details" } }] } } }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    }
  }

  async function sendWhatsAppSlotButtons(to: string, phoneId: string, slots: string[], dateStr: string) {
    const displayed = slots.slice(0, 10);
    const slotMap = Object.fromEntries(displayed.map((t, i) => [`slot_${i}`, t]));
    const cacheKey = `whatsapp:${to}`;
    const draft = bookingDrafts.get(cacheKey) || {};
    bookingDrafts.set(cacheKey, { ...draft, slotMap });
    const rows = displayed.map((t, i) => ({ id: `slot_${i}`, title: t.slice(0, 24), description: "Tap to book" }));
    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: { type: "list", header: { type: "text", text: "Choose Slot" }, body: { text: `${formatDateDisplay(dateStr)} ke slots:` }, action: { button: "Pick a Slot", sections: [{ title: "Slots", rows }] } }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  }

  async function sendWhatsAppConfirmation(to: string, phoneId: string, draft: any, user: any) {
    const summary = `*Summary*\n\n*Service:* ${draft.serviceName}\n*Date:* ${formatDateDisplay(draft.date)}\n*Time:* ${draft.time}\n\nConfirm?`;
    await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: { type: "button", body: { text: summary }, action: { buttons: [{ type: "reply", reply: { id: "confirm_booking", title: "Confirm" } }, { type: "reply", reply: { id: "cancel_booking", title: "Cancel" } }] } }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  }

  function formatServiceDetails(service: any): string {
    const lines = [`🧽 *${service.name}*`, `─────────────────────────`, `💰 *Price:* ₹${service.price}`, `⏱️ *Duration:* ${service.time}`];
    if (service.whatIncludes?.length) { lines.push(``, `✅ *Included:*`); service.whatIncludes.forEach((d: string) => lines.push(` › ${d}`)); }
    return lines.join('\n');
  }

  async function sendServiceDetailsMessage(to: string, phoneId: string, details: any) {
    await sendWhatsAppText(to, phoneId, formatServiceDetails(details));
  }

  const CARMAA_CONTEXT = ` Friendly Hinglish sales rep for Carmaa Car Care (India). Rules: Use Hinglish. Keep sentences short. Short English tech words OK. Greeting: "Namaste! Kaise help kar sakta hoon?". NO "Hi/Hello". NO "I am AI". `;

  async function callAI(messages: any[], systemInstruction: string): Promise<string> {
    try {
      const gemmaKey = process.env.GEMMA_API_KEY; const gemmaModel = process.env.GEMMA_MODEL;
      console.log(`[AI] Trying Gemma model: ${gemmaModel}, key exists: ${!!gemmaKey}`);
      if (gemmaKey?.length > 10) {
        const { GoogleGenAI } = await import('@google/genai');
        const genAI = new GoogleGenAI({ apiKey: gemmaKey });
        const history = messages.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
        const response = await genAI.models.generateContent({ model: gemmaModel, contents: history, config: { systemInstruction } });
        if (response.text) { console.log(`[AI] Gemma responded OK`); return response.text; }
      }
    } catch (err: any) { console.error(`[AI] Gemma failed:`, err.message); }
    try {
      const geminiKey = process.env.GEMINI_API_KEY; const geminiModel = process.env.GEMINI_MODEL;
      console.log(`[AI] Trying Gemini model: ${geminiModel}, key exists: ${!!geminiKey}`);
      if (geminiKey?.length > 10) {
        const { GoogleGenAI } = await import('@google/genai');
        const genAI = new GoogleGenAI({ apiKey: geminiKey });
        const history = messages.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
        const response = await genAI.models.generateContent({ model: geminiModel, contents: history, config: { systemInstruction } });
        if (response.text) { console.log(`[AI] Gemini responded OK`); return response.text; }
      }
    } catch (err: any) { console.error(`[AI] Gemini failed:`, err.message); }
    console.error(`[AI] Both models failed, returning fallback`);
    return "Bro, AI thoda busy hai abhi! Ek min mein dobara try karo.";
  }

  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"]; const token = req.query["hub.verify_token"]; const challenge = req.query["hub.challenge"];
    const expectedToken = (process.env.WHATSAPP_VERIFY_TOKEN || "carmaa_secret").trim();
    if (mode === "subscribe" && token === expectedToken) return res.status(200).send(challenge);
    return res.status(200).send("Webhook LIVE.");
  });

  app.post("/webhook", async (req, res) => {
    const body = req.body;
    console.log(`[Webhook] Received: ${JSON.stringify(body).slice(0, 200)}`);
    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0]?.changes?.[0]?.value;
      if (entry?.messages?.[0]) {
        const mid = entry.messages[0].id;
        console.log(`[Webhook] Message ID: ${mid}, already processed: ${processedMids.has(mid)}`);
        if (processedMids.has(mid)) return res.sendStatus(200);
        processedMids.set(mid, Date.now()); res.sendStatus(200);
        let msg_text = entry.messages[0].type === 'text' ? entry.messages[0].text?.body : (entry.messages[0].interactive?.button_reply?.id || entry.messages[0].interactive?.list_reply?.id || "");
        console.log(`[Webhook] Processing message from ${entry.messages[0].from}: "${msg_text}"`);
        (async () => { await handleMessage(entry.messages[0].from, msg_text, 'whatsapp', entry.metadata.phone_number_id); })();
        return;
      }
    }
    res.sendStatus(200);
  });

  app.post("/api/chat/web", async (req, res) => {
    const { userId, text } = req.body;
    const aiResponse = await handleMessage(userId, text, 'web');
    res.json({ text: aiResponse });
  });

  app.get("/widget.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.send(`(function(){ /* Minimal Widget JS code here... */ })();`);
  });

  async function handleMessage(userId: string, text: string, platform: string, phoneId?: string): Promise<string> {
    const cacheKey = `${platform}:${userId}`;
    const isWhatsApp = platform === 'whatsapp' && !!phoneId;

    try {
      const cleanId = userId.toString().replace(/\s+/g, '').replace('+', '');
      const isNumeric = /^\d+$/.test(cleanId);
      const userQuery: any = { $or: [{ user_id: cleanId }] };
      if (isNumeric) {
        userQuery.$or.push({ mobile_number: Number(cleanId) });
        if (cleanId.startsWith('91') && cleanId.length === 12) userQuery.$or.push({ mobile_number: Number(cleanId.substring(2)) });
      }
      const dbUser = await User.findOne(userQuery);
      const resolved = await resolveUserData(dbUser);
      const regionId = resolveRegionId(resolved);
      const carType = resolved?.suggestedCar?.car_type || 'hatchback';

      let messages = contextCache.get(cacheKey) || [];
      if (messages.length === 0) {
        const chat = await Chat.findOne({ userId, platform });
        if (chat) messages = [...(chat.messages || [])];
      }

      const timestamp = new Date();
      console.log(`\n[${timestamp.toLocaleTimeString()}] INCOMING [${platform}] from ${userId}: "${text}"`);

      let draft = bookingDrafts.get(cacheKey) || { step: 'idle' };
      let interactiveHandled = false;
      let systemMessage = "";

      const cancelIntent = /nahi\s*chahiye|mat\s*karo|don.?t\s*want|not\s*interested|bad\s*service|choro\s*yar|chhodo|nai\s*chahiye|band\s*karo|no\s*booking|no\s*thanks|nai\s*krni|nai\s*karni/i.test(text);
      if (cancelIntent && draft.step !== 'idle') {
        bookingDrafts.delete(cacheKey);
        draft = { step: 'idle' };
        systemMessage = 'User expressed they do NOT want a booking or is unhappy. Empathize genuinely, apologize if needed, and reset completely. Do NOT mention booking or services unless they bring it up.';
        interactiveHandled = true;
      }

      if (!interactiveHandled && text === 'show_more_services') {
        const allServices = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
        userServiceCache.set(cacheKey, allServices);
        const currentOffset = (draft.serviceOffset || 0) + 10;
        if (isWhatsApp && allServices.length > currentOffset) {
          await sendWhatsAppServiceList(userId, phoneId!, allServices, currentOffset);
          draft = { ...draft, step: 'picking_service', serviceOffset: currentOffset };
          bookingDrafts.set(cacheKey, draft);
        } else if (isWhatsApp) {
          await sendWhatsAppText(userId, phoneId!, 'Yeh sab services hain. Ab choose karo');
        }
        messages.push({ role: 'user', text, timestamp });
        messages.push({ role: 'model', text: 'Services dikhaye gaye', timestamp: new Date() });
        contextCache.set(cacheKey, messages.slice(-20));
        persistChat(userId, platform, messages);
        return '';
      }

      if (!interactiveHandled && text === 'show_more_info_services') {
        const allServices = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
        userServiceCache.set(cacheKey, allServices);
        const currentOffset = (draft.serviceOffset || 0) + 10;
        if (isWhatsApp && allServices.length > currentOffset) {
          await sendWhatsAppServiceInfoList(userId, phoneId!, allServices, currentOffset);
          draft = { ...draft, step: 'picking_service', serviceOffset: currentOffset };
          bookingDrafts.set(cacheKey, draft);
        }
        messages.push({ role: 'user', text, timestamp });
        messages.push({ role: 'model', text: 'Services info widget sent', timestamp: new Date() });
        contextCache.set(cacheKey, messages.slice(-20));
        persistChat(userId, platform, messages);
        return '';
      }

      if (text.startsWith('svc_info_')) {
        const serviceId = text.replace('svc_info_', '');
        const allServices = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
        const selectedService = allServices.find((s: any) => s._id === serviceId);
        if (selectedService) {
          const fullDetails = await getServiceDetails(serviceId, regionId);
          if (isWhatsApp && fullDetails) await sendServiceDetailsMessage(userId, phoneId!, fullDetails);
          draft = { ...draft, step: 'viewing_details', serviceId: selectedService._id, serviceName: selectedService.name, price: selectedService.price, discount: selectedService.discount || 0, serviceOffset: 0 };
          bookingDrafts.set(cacheKey, draft);
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: 'Service details bheje gaye', timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return '';
        }
        interactiveHandled = true;
      } else if (text.startsWith('svc_')) {
        const serviceId = text.replace('svc_', '');
        const allServices = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
        const selectedService = allServices.find((s: any) => s._id === serviceId);
        if (selectedService) {
          draft = { ...draft, step: 'picking_date', serviceId: selectedService._id, serviceName: selectedService.name, price: selectedService.price, discount: selectedService.discount || 0, serviceOffset: 0 };
          bookingDrafts.set(cacheKey, draft);
          const bookingPrompt = `Awesome choice! Aapne *${selectedService.name}* select kiya hai.\n\nAapko yeh service kis date ko chahiye? (e.g., Today, Tomorrow, ya koi specific date bataiye)`;
          if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, bookingPrompt);
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: bookingPrompt, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return bookingPrompt;
        } else { interactiveHandled = true; }
      } else if (text.startsWith('slot_')) {
        const slotMap = draft.slotMap || {};
        const time = slotMap[text] || text.replace('slot_', '');
        draft = { ...draft, step: 'confirming', time };
        bookingDrafts.set(cacheKey, draft);
        if (isWhatsApp && resolved) {
          await sendWhatsAppConfirmation(userId, phoneId!, draft, resolved);
          const confirmMsg = `Booking confirm karne ke liye niche button dabayein: ${draft.serviceName} on ${formatDateDisplay(draft.date)} at ${time}.`;
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: confirmMsg, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return confirmMsg;
        }
        systemMessage = `User picked time slot: ${time}. Show them a confirmation summary and ask to confirm.`;
        interactiveHandled = true;
      } else if (text === 'confirm_booking') {
        if (draft.step === 'confirming' && draft.serviceId && draft.date && draft.time && resolved) {
          const result = await createBookingViaAPI(draft, resolved);
          if (result.success) {
            const successText = `Booking ho gayi!\n\nService: ${draft.serviceName}\nDate: ${formatDateDisplay(draft.date)}\nTime: ${draft.time}\n\nOur team will reach you on time.`;
            if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, successText);
            bookingDrafts.delete(cacheKey);
            messages.push({ role: 'user', text: 'confirm_booking', timestamp });
            messages.push({ role: 'model', text: successText, timestamp: new Date() });
            contextCache.set(cacheKey, messages.slice(-20));
            persistChat(userId, platform, messages);
            return successText;
          } else {
            const errText = `Bhai, kuch technical issue hua! Please call us directly or try again. Error: ${result.error}`;
            if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, errText);
            return errText;
          }
        }
        systemMessage = "User wants to confirm booking but details are incomplete. Ask them to restart the booking flow.";
        interactiveHandled = true;
      } else if (text === 'cancel_booking') {
        bookingDrafts.delete(cacheKey);
        const cancelText = "No problem bhai! Jab bhi gaadi chamkani ho, batao.";
        if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, cancelText);
        messages.push({ role: 'user', text: 'cancel_booking', timestamp });
        messages.push({ role: 'model', text: cancelText, timestamp: new Date() });
        contextCache.set(cacheKey, messages.slice(-20));
        persistChat(userId, platform, messages);
        return cancelText;
      }

      const inDateSelection = draft.step === 'picking_date' || draft.step === 'picking_slot';
      if (!interactiveHandled && (inDateSelection || text.match(/today|tomorrow|kal|aaj|parso|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})/i))) {
        const parsedDate = parseUserDate(text, inDateSelection);
        if (parsedDate) {
          if (isDateInPast(parsedDate)) {
            const pastMsg = `Bhai, ${formatDateDisplay(parsedDate)} toh already guzar gayi! Future date batao - kab chahiye?`;
            if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, pastMsg);
            messages.push({ role: 'user', text, timestamp });
            messages.push({ role: 'model', text: pastMsg, timestamp: new Date() });
            contextCache.set(cacheKey, messages.slice(-20));
            persistChat(userId, platform, messages);
            return pastMsg;
          }
          if (inDateSelection) {
            const regionQuery: any = { date: parsedDate, weeklyOff: { $ne: true } };
            if (regionId && mongoose.Types.ObjectId.isValid(regionId)) regionQuery.region = new mongoose.Types.ObjectId(regionId);
            let exactDoc = await AvailableSlots.findOne(regionQuery).lean() as any || await AvailableSlots.findOne({ date: parsedDate, weeklyOff: { $ne: true } }).lean() as any;
            if (!exactDoc) {
              const nearestDoc = await AvailableSlots.findOne({ date: { $gt: parsedDate }, weeklyOff: { $ne: true } }).sort({ date: 1 }).lean() as any;
              if (nearestDoc) {
                const offerMsg = `Bhai, *${formatDateDisplay(parsedDate)}* ke liye koi slot nahi hai. Nearest available date hai *${formatDateDisplay(nearestDoc.date)}*. Kya us din book karein?`;
                if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, offerMsg);
                draft = { ...draft, step: 'picking_date', _suggestedDate: nearestDoc.date };
                bookingDrafts.set(cacheKey, draft);
                messages.push({ role: 'user', text, timestamp });
                messages.push({ role: 'model', text: offerMsg, timestamp: new Date() });
                contextCache.set(cacheKey, messages.slice(-20));
                persistChat(userId, platform, messages);
                return offerMsg;
              } else {
                const noSlotMsg = `Bhai, koi date available nahi dikh raha. Please humein call karein!`;
                if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, noSlotMsg);
                return noSlotMsg;
              }
            }
            const slotsRaw: string[] = (exactDoc.timeSlots || []).filter((s: any) => !s.maxLimit || s.bookingCount < s.maxLimit).map((s: any) => s.time);
            const todayStr = new Date().toISOString().split('T')[0];
            let slots = slotsRaw;
            if (parsedDate === todayStr) {
              const now = new Date();
              const cutoff = new Date(now.getTime() + 2 * 60 * 60 * 1000);
              const cutoffH = cutoff.getHours(), cutoffM = cutoff.getMinutes();
              slots = slotsRaw.filter(t => {
                const m2 = t.split('-')[0]?.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
                if (!m2) return false;
                let h = parseInt(m2[1]); const mn = parseInt(m2[2]); const p = m2[3].toUpperCase();
                if (p === 'PM' && h !== 12) h += 12;
                if (p === 'AM' && h === 12) h = 0;
                return h > cutoffH || (h === cutoffH && mn >= cutoffM);
              });
            }
            if (slots.length === 0) {
              const noTimeMsg = `Bhai, ${formatDateDisplay(parsedDate)} ke liye koi slot available nahi. Koi aur date try karo?`;
              if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, noTimeMsg);
              messages.push({ role: 'user', text, timestamp });
              messages.push({ role: 'model', text: noTimeMsg, timestamp: new Date() });
              contextCache.set(cacheKey, messages.slice(-20));
              persistChat(userId, platform, messages);
              return noTimeMsg;
            }
            draft = { ...draft, step: 'picking_slot', date: parsedDate };
            bookingDrafts.set(cacheKey, draft);
            if (isWhatsApp) {
              await sendWhatsAppText(userId, phoneId!, `Okay! ${formatDateDisplay(parsedDate)} ke liye slot dhundta hoon...`);
              await sendWhatsAppSlotButtons(userId, phoneId!, slots, parsedDate);
            }
            const slotMsg = `${parsedDate} ke liye available slots: ${slots.join(', ')}`;
            messages.push({ role: 'user', text, timestamp });
            messages.push({ role: 'model', text: slotMsg, timestamp: new Date() });
            contextCache.set(cacheKey, messages.slice(-20));
            persistChat(userId, platform, messages);
            return slotMsg;
          }
        } else if (inDateSelection && !parsedDate) {
          const nudge = `Bhai, date samajh nahi aaya! Yeh try karo:\n- "kal" (tomorrow)\n- "29 April"\n- "2026-04-29"\nKab chahiye service?`;
          if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, nudge);
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: nudge, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return nudge;
        }
      }

      if (!interactiveHandled && draft.step === 'picking_slot' && draft.date && draft.slotMap) {
        const { slots } = await getAvailableSlots(regionId, draft.date);
        if (isWhatsApp && slots.length > 0) {
          await sendWhatsAppText(userId, phoneId!, `Bhai, slot select karo na! Yeh dekho:`);
          await sendWhatsAppSlotButtons(userId, phoneId!, slots, draft.date);
          messages.push({ role: 'user', text, timestamp });
          const msg2 = `Slot fir se bheja ${draft.date} ke liye`;
          messages.push({ role: 'model', text: msg2, timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return msg2;
        }
      }

      const wantsServiceDetails = /details?|info|kya.*details|show.*detail|service.*detail|kitna.*time|full.*detail|thoda.*details|details?.*chahiye/i.test(text);
      const wantsServices = /service|book|wash|clean|menu|what.*offer|kya.*milega|packages?|show more|aur.*dikhao|more service|kitne.*options/i.test(text);
      const wantsMoreServices = /^(more|aur dikhao|aur batao|baaki|remaining|show more|next)$/i.test(text.trim());

      if (wantsServiceDetails) {
        const allServices = await getServicesForUser(regionId, carType);
        userServiceCache.set(cacheKey, allServices);
        if (isWhatsApp && allServices.length > 0) {
          await sendWhatsAppServiceInfoList(userId, phoneId!, allServices, 0);
          draft = { ...draft, step: 'picking_service', serviceOffset: 0 };
          bookingDrafts.set(cacheKey, draft);
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: 'Service details widget sent', timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return '';
        }
      } else if (wantsServices || wantsMoreServices) {
        const allServices = await getServicesForUser(regionId, carType);
        userServiceCache.set(cacheKey, allServices);
        if (isWhatsApp && allServices.length > 0) {
          const currentOffset = (wantsMoreServices && !wantsServices) ? (draft.serviceOffset || 0) + 10 : 0;
          await sendWhatsAppServiceList(userId, phoneId!, allServices, currentOffset);
          draft = { ...draft, step: 'picking_service', serviceOffset: currentOffset };
          bookingDrafts.set(cacheKey, draft);
          messages.push({ role: 'user', text, timestamp });
          messages.push({ role: 'model', text: 'Services dikhaye gaye', timestamp: new Date() });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return '';
        }
      }

      if (draft.step === 'viewing_details') {
        const wantsToBook = /book|book karo|confirm|book karna|book krna/i.test(text);
        const dateDetected = /today|tomorrow|kal|aaj|parso|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})/i.test(text);
        if (wantsToBook || dateDetected) {
          draft.step = 'picking_date';
          bookingDrafts.set(cacheKey, draft);
        } else {
          messages.push({ role: 'user', text, timestamp });
          contextCache.set(cacheKey, messages.slice(-20));
          persistChat(userId, platform, messages);
          return '';
        }
      }

      const servicesForContext = userServiceCache.get(cacheKey) || await getServicesForUser(regionId, carType);
      if (!userServiceCache.has(cacheKey)) userServiceCache.set(cacheKey, servicesForContext);
      const dynamicKnowledge = await getDynamicKnowledge(userId, servicesForContext);
      const draftContext = draft.step !== 'idle' ? `\nCURRENT BOOKING DRAFT:\n- Step: ${draft.step}\n- Service: ${draft.serviceName || 'not selected'} (₹${draft.price || '?'})\n- Date: ${draft.date || 'not selected'}\n- Time: ${draft.time || 'not selected'}\n` : '';

      messages.push({ role: "user", text, timestamp });
      const aiResponse = await callAI(messages.slice(-10), CARMAA_CONTEXT + "\n\n" + dynamicKnowledge + draftContext + (interactiveHandled ? `\n\nSYSTEM NOTE: ${systemMessage}` : ''));

      console.log(`[${new Date().toLocaleTimeString()}] OUTGOING [${platform}] to ${userId}: "${aiResponse.slice(0, 60)}..."`);
      messages.push({ role: "model", text: aiResponse, timestamp: new Date() });
      contextCache.set(cacheKey, messages.slice(-20));
      persistChat(userId, platform, messages);
      if (isWhatsApp) await sendWhatsAppText(userId, phoneId!, aiResponse);
      return aiResponse;

    } catch (error: any) {
      if (error.response?.status === 401) {
        console.error("WHATSAPP ERROR: Token Expired");
      } else {
        console.error("Error in handleMessage:", error.message || error);
      }
      return "Sorry bhai, kuch gadbad hai! Thoda wait karo.";
    }
  }

  function persistChat(userId: string, platform: string, messages: any[]) {
    (async () => {
      const { score, reason } = calculateLeadScore(messages);
      await Chat.findOneAndUpdate(
        { userId, platform },
        { $set: { messages, leadScore: score, scoreReason: reason, lastUpdated: new Date() } },
        { upsert: true }
      );
    })().catch(err => console.error("DB Update Error:", err));
  }

  // --- Vite Middleware (local dev only) ---
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    const distPath = path.join(__dirname, "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }
  }
  return app;
}

let _app: any;
async function getApp() {
  if (!_app) { await connectDB(); _app = await startServer(); }
  return _app;
}

export default async function handler(req: any, res: any) {
  const app = await getApp();
  app(req, res);
}

if (!process.env.VERCEL) {
  const PORT = parseInt(process.env.PORT || "3000");
  getApp().then(app => app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on http://localhost:${PORT}`)));
}
