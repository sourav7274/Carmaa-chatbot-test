import React, { useState, useEffect } from "react";
import { 
  MessageSquare, 
  Settings, 
  CheckCircle2, 
  AlertCircle, 
  ArrowRight, 
  Car, 
  ShieldCheck, 
  Clock, 
  Zap,
  ChevronRight,
  Send,
  User,
  Bot
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI } from "@google/genai";

// --- Types ---
interface Message {
  id: string;
  role: "user" | "bot";
  text: string;
  timestamp: Date;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "setup" | "test" | "logs">("dashboard");
  const [selectedChat, setSelectedChat] = useState<any | null>(null);
  const [manualText, setManualText] = useState("");
  const [webhookLogs, setWebhookLogs] = useState<any[]>([]);
  const [realChats, setRealChats] = useState<any[]>([]);
  const [platformFilter, setPlatformFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [messages, setMessages] = useState<Message[]>([
    { id: "1", role: "bot", text: "Namaste! Main Carmaa se bol raha hoon. Gaadi chamkani hai kya?", timestamp: new Date() }
  ]);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  const [stats, setStats] = useState({ liveChats: 0, platforms: 4, uptime: "99.9%" });
  const [platformStats, setPlatformStats] = useState<any>({});

  // --- Fetch Data ---
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
        const data = await res.json();
        if (data.logs) setWebhookLogs(data.logs);
  
        const chatRes = await fetch(`/api/chats?page=${pagination.page}&limit=10&platform=${platformFilter}&search=${searchQuery}`);
        if (!chatRes.ok) throw new Error(`Chats fetch failed: ${chatRes.status}`);
        const chatData = await chatRes.json();
        setRealChats(chatData.chats);
        setPagination(prev => ({
          ...prev,
          totalPages: chatData.totalPages,
          total: chatData.total
        }));

        const statsRes = await fetch("/api/stats");
        if (statsRes.ok) {
          const sData = await statsRes.json();
          setPlatformStats(sData);
        }

        // Update stats
        setStats(prev => ({ ...prev, liveChats: chatData.total }));
      } catch (e) {
        console.error("Data fetch error:", e);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [pagination.page, platformFilter, searchQuery]);

  // --- AI Setup for Test Chat ---
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  
  const handleSendMessage = async () => {
    if (!inputText.trim()) return;

    const userMsg: Message = { id: Date.now().toString(), role: "user", text: inputText, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInputText("");
    setIsTyping(true);

    try {
      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: inputText,
        config: {
          systemInstruction: `
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
          `,
        },
      });

      const botMsg: Message = { 
        id: (Date.now() + 1).toString(), 
        role: "bot", 
        text: response.text || "I'm sorry, I couldn't process that.", 
        timestamp: new Date() 
      };
      setMessages(prev => [...prev, botMsg]);
    } catch (error) {
      console.error("AI Error:", error);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSendManual = async () => {
    if (!manualText.trim() || !selectedChat) return;
    
    try {
      const res = await fetch("/api/chat/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedChat.userId, text: manualText })
      });
      
      if (res.ok) {
        const data = await res.json();
        setSelectedChat(data.chat);
        setManualText("");
        // Refresh the main list too
        const chatRes = await fetch("/api/chats");
        const chatData = await chatRes.json();
        setRealChats(chatData.chats || []);
      }
    } catch (e) {
      console.error("Failed to send manual response:", e);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans selection:bg-orange-100">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-white border-r border-gray-200 p-6 z-20 hidden md:block text-left">
        <div className="flex items-center gap-2 mb-10">
          <div className="w-10 h-10 bg-orange-600 rounded-xl flex items-center justify-center text-white">
            <Car size={24} />
          </div>
          <span className="text-xl font-bold tracking-tight">Carmaa <span className="text-orange-600">AI</span></span>
        </div>

        <nav className="space-y-2">
          <NavItem 
            icon={<Zap size={20} />} 
            label="Dashboard" 
            active={activeTab === "dashboard"} 
            onClick={() => setActiveTab("dashboard")} 
          />
          <NavItem 
            icon={<Settings size={20} />} 
            label="Webhook Setup" 
            active={activeTab === "setup"} 
            onClick={() => setActiveTab("setup")} 
          />
          <NavItem 
            icon={<MessageSquare size={20} />} 
            label="Test Chatbot" 
            active={activeTab === "test"} 
            onClick={() => setActiveTab("test")} 
          />
          <NavItem 
            icon={<AlertCircle size={20} />} 
            label="Webhook Logs" 
            active={activeTab === "logs"} 
            onClick={() => setActiveTab("logs")} 
          />
        </nav>

        <div className="absolute bottom-10 left-6 right-6">
          <div className="p-4 bg-orange-50 rounded-2xl border border-orange-100">
            <p className="text-xs font-semibold text-orange-800 uppercase tracking-wider mb-1">Current Plan</p>
            <p className="text-sm font-bold text-orange-900">Startup Beta</p>
            <div className="mt-3 h-1.5 w-full bg-orange-200 rounded-full overflow-hidden text-left">
              <div className="h-full w-2/3 bg-orange-600 rounded-full" />
            </div>
            <p className="text-[10px] text-orange-700 mt-2">642 / 1000 messages used</p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="md:ml-64 p-4 md:p-10 text-left">
        <header className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-1">
              {activeTab === "dashboard" && "Performance Overview"}
              {activeTab === "setup" && "WhatsApp Integration"}
              {activeTab === "test" && "AI Playground"}
              {activeTab === "logs" && "Live Webhook Debugger"}
            </h1>
            <p className="text-gray-500 text-sm">
              {activeTab === "dashboard" && "Monitoring your AI sales agents in real-time."}
              {activeTab === "setup" && "Connect Carmaa AI to your Meta Business account."}
              {activeTab === "test" && "Simulate how the AI interacts with your customers."}
              {activeTab === "logs" && "See exactly what Meta is sending to your server."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-100">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              Live System
            </div>
            <button className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors">
              <User size={20} className="text-gray-600" />
            </button>
          </div>
        </header>

        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-6"
            >
              <div className="lg:col-span-2 space-y-6">
                <div className="grid grid-cols-3 gap-4">
                  <StatCard label="Live Chats" value={stats.liveChats.toString()} change="Real-time" trend="up" />
                  <StatCard label="Platforms" value={stats.platforms.toString()} change="Active" trend="up" />
                  <StatCard label="AI Uptime" value={stats.uptime} change="Stable" trend="up" />
                </div>

                <div className="bg-white rounded-3xl border border-gray-200 overflow-hidden">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg">Active Conversations</h3>
                      <p className="text-xs text-gray-400 font-medium">Real-time from MongoDB</p>
                    </div>
                    <div className="flex flex-col md:flex-row gap-4">
                      <div className="relative">
                        <input
                          type="text"
                          placeholder="Search Phone / ID..."
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            setPagination(prev => ({ ...prev, page: 1 }));
                          }}
                          className="pl-9 pr-4 py-1.5 bg-gray-50 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all w-48"
                        />
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                          <User size={14} />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {['all', 'whatsapp', 'instagram', 'web', 'import'].map((p) => (
                          <button
                            key={p}
                            onClick={() => {
                              setPlatformFilter(p);
                              setPagination(prev => ({ ...prev, page: 1 }));
                            }}
                            className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                              platformFilter === p 
                                ? "bg-gray-900 text-white" 
                                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {realChats.length === 0 ? (
                      <div className="p-10 text-center text-gray-400">No active chats yet. Connect your platforms!</div>
                    ) : (
                      realChats
                        .sort((a, b) => {
                          const scoreMap: any = { hot: 3, warm: 2, cold: 1 };
                          return (scoreMap[b.leadScore] || 1) - (scoreMap[a.leadScore] || 1);
                        })
                        .map((chat) => {
                          const profile = chat.userProfile;
                          const name = profile?.name || chat.name || "Unknown Customer";
                          const isPlatinum = (profile?.total_earned || 0) > 5000;
                          const suggestedCarName = profile?.suggestedCar?.car_name || "No Car";
                          const carCount = profile?.resolvedCars?.length || 0;

                          return (
                          <div key={chat._id} className="p-6 flex items-center justify-between hover:bg-gray-50 transition-colors">
                            <div className="flex items-center gap-4 text-left">
                              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-lg ${
                                isPlatinum ? 'bg-orange-600 text-white' : 'bg-gray-100 text-gray-400'
                              }`}>
                                {name.charAt(0)}
                              </div>
                              <div className="text-left">
                                <div className="flex items-center gap-2">
                                  <p className="font-black text-gray-900 truncate max-w-[140px] leading-tight">{name}</p>
                                  {isPlatinum && (
                                    <span className="bg-orange-100 text-orange-600 text-[8px] font-black uppercase px-1 py-0.5 rounded tracking-tighter shrink-0">Platinum</span>
                                  )}
                                </div>
                                <div className="space-y-0.5 mt-0.5">
                                  <p className="text-[10px] font-bold text-gray-400 font-mono tracking-tighter">+{chat.userId}</p>
                                  <div className="flex items-center gap-2">
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-widest ${
                                      chat.leadScore === 'hot' ? 'bg-red-100 text-red-700' : 
                                      chat.leadScore === 'warm' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                                    }`}>
                                      {chat.leadScore || 'cold'}
                                    </span>
                                    <p className="text-[10px] text-gray-400 font-bold flex items-center gap-1 capitalize">
                                      <span className={`w-1 h-1 rounded-full ${chat.platform === 'whatsapp' ? 'bg-green-500' : 'bg-blue-500'}`} />
                                      {suggestedCarName}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <button 
                              onClick={() => setSelectedChat(chat)}
                              className="px-4 py-2 bg-gray-900 text-white rounded-xl text-xs font-bold hover:bg-gray-800 transition-colors"
                            >
                              Details
                            </button>
                          </div>
                        )})
                    )}
                  </div>

                  {/* Pagination Controls */}
                  {pagination.totalPages > 1 && (
                    <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-6">
                      <p className="text-xs text-gray-500">
                        Showing <span className="font-bold text-gray-900">{realChats.length}</span> of <span className="font-bold text-gray-900">{pagination.total}</span> chats
                      </p>
                      <div className="flex gap-2">
                        <button 
                          disabled={pagination.page === 1}
                          onClick={() => setPagination(p => ({ ...p, page: p.page - 1 }))}
                          className="px-4 py-2 border border-gray-200 rounded-xl text-xs font-bold hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          Previous
                        </button>
                        <div className="flex items-center px-4 text-xs font-bold text-gray-400">
                          Page {pagination.page} of {pagination.totalPages}
                        </div>
                        <button 
                          disabled={pagination.page === pagination.totalPages}
                          onClick={() => setPagination(p => ({ ...p, page: p.page + 1 }))}
                          className="px-4 py-2 border border-gray-200 rounded-xl text-xs font-bold hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white rounded-3xl border border-gray-200 p-8">
                <h3 className="font-bold text-lg mb-6">Platform Distribution</h3>
                <div className="space-y-6">
                  {['whatsapp', 'instagram', 'web', 'import'].map((p) => {
                    const count = platformStats[p] || 0;
                    const total = Object.values(platformStats).reduce((a: any, b: any) => a + b, 0) as number;
                    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
                    const colors: any = {
                      whatsapp: 'bg-green-500',
                      instagram: 'bg-purple-500',
                      web: 'bg-blue-500',
                      import: 'bg-orange-500'
                    };
                    return (
                      <ServiceStat key={p} label={p.charAt(0).toUpperCase() + p.slice(1)} percentage={percentage} color={colors[p]} />
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === "setup" && (
            <motion.div 
              key="setup"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="max-w-3xl space-y-8"
            >
              <div className="bg-white rounded-3xl border border-gray-200 p-8">
                <h3 className="font-bold text-xl mb-6 flex items-center gap-2">
                  <ShieldCheck className="text-orange-600" />
                  Step-by-Step Integration Guide
                </h3>
                
                <div className="space-y-8">
                  <Step 
                    number="01" 
                    title="Meta Developer Account" 
                    desc="Go to developers.facebook.com and create a Business App." 
                  />
                  <Step 
                    number="02" 
                    title="Configure WhatsApp" 
                    desc="Add the WhatsApp product to your app and get your Phone Number ID." 
                  />
                  <div className="p-4 bg-red-50 border border-red-100 rounded-2xl mb-6">
                    <p className="text-red-800 font-bold text-sm flex items-center gap-2">
                      <AlertCircle size={18} />
                      CRITICAL: Use the Shared URL
                    </p>
                    <p className="text-red-700 text-xs mt-1">
                      Meta cannot reach your "dev" URL. You MUST use your <strong>Shared App URL</strong> (the one starting with <code>ais-pre</code>) for the webhook to work.
                    </p>
                  </div>

                  <Step 
                    number="03" 
                    title="Set Webhook URL" 
                    desc="Copy this URL into the Meta Dashboard 'Callback URL' field:"
                    code={`https://ais-pre-z3lw7wggbthh3a6knw2ahp-637488416286.asia-southeast1.run.app/webhook`}
                  />
                  <Step 
                    number="04" 
                    title="Verify Token" 
                    desc="Use this exact string in the 'Verify Token' field:"
                    code="carmaa_secret"
                  />
                  
                  <div className="pt-6 border-t border-gray-100 flex gap-3">
                    <button 
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/health");
                          const data = await res.json();
                          alert("✅ Server is LIVE!\nTime: " + data.time + "\nLogs in memory: " + (data.logs?.length || 0));
                        } catch (e) {
                          alert("❌ Server is unreachable. Please wait for it to restart or check the 'Share' status.");
                        }
                      }}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-200 transition-colors"
                    >
                      <Zap size={16} />
                      Check Server
                    </button>
                    <button 
                      onClick={async () => {
                        try {
                          const url = `${window.location.origin}/webhook?hub.mode=subscribe&hub.verify_token=carmaa_secret&hub.challenge=TEST_CHALLENGE`;
                          const res = await fetch(url);
                          const text = await res.text();
                          if (text === "TEST_CHALLENGE") {
                            alert("✅ Webhook Simulation Success!\nThe server correctly handled the verification request.");
                          } else {
                            alert("❌ Webhook Simulation Failed.\nResponse: " + text);
                          }
                        } catch (e) {
                          alert("❌ Simulation Error: " + e);
                        }
                      }}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-semibold hover:bg-blue-100 transition-colors"
                    >
                      <MessageSquare size={16} />
                      Simulate Meta Request
                    </button>
                  </div>
                  <Step 
                    number="05" 
                    title="Subscribe to Messages" 
                    desc="Under Webhook Fields, subscribe to 'messages' (WhatsApp) or 'messages' (Messenger/Instagram)." 
                  />

                  <div className="pt-8 border-t border-gray-100">
                    <h3 className="font-bold text-lg mb-2">Website Chat Widget</h3>
                    <p className="text-gray-500 text-sm mb-4">Add this snippet to your website's <code>&lt;body&gt;</code>. It's now fully functional and connected to Carmaa Bro!</p>
                    <pre className="bg-gray-900 text-green-400 p-6 rounded-2xl text-xs font-mono overflow-x-auto border border-gray-800">
{`<script>
  window.CarmaaAIConfig = {
    themeColor: '#ea580c', // Carmaa Orange
    title: 'Carmaa Bro 🚗'
  };
</script>
<script src="${window.location.origin}/widget.js" async></script>`}
                    </pre>
                    <p className="text-[10px] text-gray-400 mt-2 italic">Note: If testing locally, ensure you are using a local server (like Live Server) rather than opening the .html file directly to avoid browser security blocks.</p>
                  </div>
                </div>
              </div>

              <div className="bg-orange-600 rounded-3xl p-8 text-white flex items-center justify-between">
                <div>
                  <h4 className="text-xl font-bold mb-2 text-left">Need help with Meta?</h4>
                  <p className="text-orange-100 opacity-90 text-left">Our technical team can help you set this up in 15 minutes.</p>
                </div>
                <button className="px-6 py-3 bg-white text-orange-600 rounded-xl font-bold hover:bg-orange-50 transition-colors">
                  Contact Support
                </button>
              </div>
            </motion.div>
          )}

          {activeTab === "test" && (
            <motion.div 
              key="test"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="max-w-4xl mx-auto h-[calc(100vh-250px)] flex flex-col bg-white rounded-3xl border border-gray-200 overflow-hidden shadow-sm"
            >
              <div className="p-4 border-bottom bg-gray-50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center text-orange-600">
                    <Bot size={24} />
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-sm">Carmaa AI Agent</p>
                    <p className="text-[10px] text-green-600 font-semibold uppercase tracking-widest">Online</p>
                  </div>
                </div>
                <button 
                  onClick={() => setMessages([{ id: "1", role: "bot", text: "Namaste! I am Carmaa AI. How can I help you with your car service today?", timestamp: new Date() }])}
                  className="text-xs text-gray-500 hover:text-orange-600 font-medium"
                >
                  Clear Chat
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`max-w-[80%] p-4 rounded-2xl text-left ${
                      msg.role === "user" 
                        ? "bg-orange-600 text-white rounded-tr-none" 
                        : "bg-gray-100 text-gray-800 rounded-tl-none"
                    }`}>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                      <p className={`text-[10px] mt-2 opacity-60 ${msg.role === "user" ? "text-right" : "text-left"}`}>
                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </motion.div>
                ))}
                {isTyping && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 p-4 rounded-2xl rounded-tl-none flex gap-1">
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" />
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0.4s]" />
                    </div>
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-gray-100 bg-white">
                <div className="relative flex items-center">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
                    placeholder="Type a message (e.g., 'What are your services?')"
                    className="w-full pl-4 pr-12 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                  />
                  <button 
                    onClick={handleSendMessage}
                    disabled={!inputText.trim() || isTyping}
                    className="absolute right-2 p-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:hover:bg-orange-600 transition-colors"
                  >
                    <Send size={18} />
                  </button>
                </div>
                <p className="text-[10px] text-center text-gray-400 mt-3 uppercase tracking-widest font-medium">
                  Powered by Gemini 3 Flash
                </p>
              </div>
            </motion.div>
          )}

          {activeTab === "logs" && (
            <motion.div 
              key="logs"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="bg-white rounded-3xl border border-gray-200 overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                  <h3 className="font-bold text-lg">Incoming Webhook Requests</h3>
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={async () => {
                        const url = `${window.location.origin}/webhook?hub.mode=subscribe&hub.verify_token=carmaa_secret&hub.challenge=DEBUG_${Math.floor(Math.random()*1000)}`;
                        await fetch(url);
                      }}
                      className="text-xs font-semibold text-blue-600 hover:underline"
                    >
                      Send Test Request
                    </button>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      Auto-refreshing
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-gray-50 max-h-[600px] overflow-y-auto">
                  {webhookLogs.length === 0 ? (
                    <div className="p-20 text-center">
                      <AlertCircle className="mx-auto text-gray-300 mb-4" size={48} />
                      <p className="text-gray-500 font-medium">No requests received yet.</p>
                      <p className="text-gray-400 text-sm mt-1">Try clicking 'Verify and Save' in the Meta Dashboard.</p>
                    </div>
                  ) : (
                    webhookLogs.slice().reverse().map((log, i) => (
                      <div key={i} className="p-6 hover:bg-gray-50 transition-colors">
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <span className={`px-2 py-1 rounded text-[10px] font-bold ${log.method === 'GET' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                              {log.method}
                            </span>
                            <span className="text-xs font-mono text-gray-400">{new Date(log.time).toLocaleTimeString()}</span>
                          </div>
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">/webhook</span>
                        </div>
                        <pre className="bg-gray-900 text-orange-400 p-4 rounded-xl text-xs font-mono overflow-x-auto border border-gray-800">
                          {JSON.stringify(log.query || log.body, null, 2)}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Chat Modal */}
        <AnimatePresence>
          {selectedChat && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white w-full max-w-5xl h-[700px] rounded-3xl overflow-hidden flex shadow-2xl"
              >
                {/* Chat Column */}
                <div className="flex-1 flex flex-col border-r border-gray-100">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-orange-100 rounded-2xl flex items-center justify-center font-bold text-orange-600">
                        {selectedChat.userId.slice(-2)}
                      </div>
                      <div className="text-left">
                        <h3 className="font-bold text-lg">{selectedChat.userProfile?.name || selectedChat.userId}</h3>
                        <p className="text-xs text-gray-400 capitalize">{selectedChat.platform} • {selectedChat.leadScore} lead</p>
                      </div>
                    </div>
                    <button onClick={() => setSelectedChat(null)} className="p-2 hover:bg-gray-200 rounded-full"><AlertCircle size={24} className="rotate-45 text-gray-400" /></button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-white">
                    {selectedChat.messages.map((msg: any, i: number) => (
                      <div key={i} className={`flex ${msg.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] p-4 rounded-2xl ${
                          msg.role === 'user' ? 'bg-gray-100 text-gray-800 rounded-tl-none' : 'bg-gray-900 text-white rounded-tr-none'
                        }`}>
                          <p className="text-sm">{msg.text}</p>
                          <p className="text-[10px] mt-2 opacity-50">{new Date(msg.timestamp).toLocaleTimeString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="p-6 border-t border-gray-100">
                    <div className="flex gap-4">
                      <input 
                        type="text" 
                        value={manualText}
                        onChange={(e) => setManualText(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSendManual()}
                        placeholder="Type a manual response..."
                        className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl"
                      />
                      <button onClick={handleSendManual} disabled={!manualText.trim()} className="px-6 py-3 bg-orange-600 text-white rounded-xl font-bold hover:bg-orange-700 transition-colors">Send</button>
                    </div>
                  </div>
                </div>

                {/* Insight Sidebar */}
                <div className="w-80 bg-gray-50 p-8 overflow-y-auto text-left">
                  <h4 className="text-sm font-black uppercase tracking-widest text-gray-400 mb-6">Customer Insight</h4>
                  
                  <div className="space-y-8">
                    {/* User Profile Info */}
                    <div>
                      <p className="text-xs font-bold text-gray-400 mb-2 uppercase">Account</p>
                      <div className="space-y-1">
                        <p className="font-bold text-gray-900 truncate">{selectedChat.userProfile?.email || "No email linked"}</p>
                        <p className="text-sm text-gray-500">{selectedChat.userId}</p>
                      </div>
                    </div>

                    {/* Financials */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-3 bg-white rounded-2xl border border-gray-200">
                        <p className="text-[10px] font-bold text-gray-400 uppercase">Wallet</p>
                        <p className="text-sm font-black text-green-600">₹{selectedChat.userProfile?.wallet || 0}</p>
                      </div>
                      <div className="p-3 bg-white rounded-2xl border border-gray-200">
                        <p className="text-[10px] font-bold text-gray-400 uppercase">Earned</p>
                        <p className="text-sm font-black text-orange-600">₹{selectedChat.userProfile?.total_earned || 0}</p>
                      </div>
                    </div>

                    {/* Registered Cars */}
                    <div>
                      <div className="flex justify-between items-center mb-3">
                        <p className="text-xs font-bold text-gray-400 uppercase">Registered Vehicles</p>
                        <span className="bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full text-[10px] font-bold">{selectedChat.userProfile?.resolvedCars?.length || 0}</span>
                      </div>
                      <div className="space-y-2">
                        {selectedChat.userProfile?.resolvedCars?.map((car: any, i: number) => (
                          <div key={i} className="flex items-center gap-3 p-3 bg-white rounded-2xl border border-gray-200 relative overflow-hidden">
                            {car.primary && <div className="absolute top-0 right-0 p-1 px-2 bg-orange-600 text-white text-[8px] font-black uppercase">Primary</div>}
                            <div className="p-2 bg-gray-50 rounded-lg text-gray-400"><Car size={16} /></div>
                            <div>
                              <p className="text-xs font-bold text-gray-900">{car.car_name}</p>
                              <p className="text-[10px] text-gray-500 uppercase font-mono">{car.vehicle_number || "No Plate"}</p>
                            </div>
                          </div>
                        ))}
                        {(!selectedChat.userProfile?.resolvedCars || selectedChat.userProfile.resolvedCars.length === 0) && (
                          <p className="text-xs text-gray-400 italic">No cars added yet</p>
                        )}
                      </div>
                    </div>

                    {/* Addresses */}
                    <div>
                      <p className="text-xs font-bold text-gray-400 mb-3 uppercase">Saved Addresses</p>
                      <div className="space-y-2">
                        {selectedChat.userProfile?.user_address?.filter((a: any) => a.status === 'active').map((addr: any, i: number) => (
                          <div key={i} className="p-3 bg-white rounded-2xl border border-gray-200 relative overflow-hidden">
                            {(addr.primary || addr._id === selectedChat.userProfile?.suggestedAddress?._id) && (
                              <div className="absolute top-0 right-0 p-1 px-2 bg-orange-600 text-white text-[8px] font-black uppercase">
                                {addr.primary ? "Primary" : "Auto-Suggest"}
                              </div>
                            )}
                            <p className="text-[10px] font-bold text-orange-600 uppercase mb-1">{addr.tag || "Address"}</p>
                            <p className="text-xs text-gray-700 leading-tight">{addr.address}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Subcomponents ---

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
        active 
          ? "bg-orange-50 text-orange-600 font-bold" 
          : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
      }`}
    >
      {icon}
      <span className="text-sm">{label}</span>
      {active && <motion.div layoutId="active-pill" className="ml-auto w-1.5 h-1.5 bg-orange-600 rounded-full" />}
    </button>
  );
}

function StatCard({ label, value, change, trend }: { label: string, value: string, change: string, trend: "up" | "down" }) {
  return (
    <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm text-left">
      <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">{label}</p>
      <div className="flex items-end gap-3">
        <h2 className="text-3xl font-bold tracking-tight">{value}</h2>
        <span className={`text-xs font-bold mb-1 ${trend === "up" ? "text-green-600" : "text-red-600"}`}>
          {change}
        </span>
      </div>
    </div>
  );
}

function LeadItem({ name, status, service, time }: { name: string, status: string, service: string, time: string }) {
  return (
    <div className="flex items-center justify-between p-4 rounded-2xl hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-100 text-left">
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center text-gray-500">
          <User size={20} />
        </div>
        <div>
          <p className="font-bold text-sm">{name}</p>
          <p className="text-xs text-gray-500">{service}</p>
        </div>
      </div>
      <div className="text-right">
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider ${
          status === "Booked" ? "bg-green-100 text-green-700" : 
          status === "Interested" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
        }`}>
          {status}
        </span>
        <p className="text-[10px] text-gray-400 mt-1">{time}</p>
      </div>
    </div>
  );
}

const ServiceStat: React.FC<{ label: string, percentage: number, color: string }> = ({ label, percentage, color }) => {
  return (
    <div className="space-y-2 text-left">
      <div className="flex justify-between text-xs font-semibold">
        <span>{label}</span>
        <span className="text-gray-500">{percentage}%</span>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 1, ease: "easeOut" }}
          className={`h-full rounded-full ${color}`} 
        />
      </div>
    </div>
  );
};

function Step({ number, title, desc, code }: { number: string, title: string, desc: string, code?: string }) {
  return (
    <div className="flex gap-6 text-left">
      <div className="flex-shrink-0 w-10 h-10 bg-gray-900 text-white rounded-full flex items-center justify-center font-bold text-sm">
        {number}
      </div>
      <div className="space-y-1 pt-1">
        <h4 className="font-bold text-gray-900">{title}</h4>
        <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
        {code && (
          <div className="mt-3 p-3 bg-gray-900 rounded-xl font-mono text-xs text-orange-400 break-all border border-gray-800">
            {code}
          </div>
        )}
      </div>
    </div>
  );
}
