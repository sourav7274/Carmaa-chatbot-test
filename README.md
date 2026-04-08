# Carmaa AI Dashboard & Chatbot

Carmaa AI is a premium door-to-door car service automation platform. It integrates with WhatsApp, Instagram, and Messenger to handle customer inquiries, provide quotes, and manage leads using Google's Gemini 3 Flash AI.

## 🚀 Features

- **Omnichannel Chatbot**: Unified AI persona ("Carmaa Bro") across WhatsApp, Instagram, and Web.
- **Lead Scoring**: Automatic categorization of customers into Cold, Warm, and Hot leads based on intent.
- **Manual Intervention**: Dashboard allows human agents to "Take Over" any AI conversation in real-time.
- **Real-time Dashboard**: Monitor active conversations, platform distribution, and lead quality.
- **Webhook Debugger**: Built-in tool to inspect incoming Meta requests for easy troubleshooting.

## 🛠️ Tech Stack

- **Frontend**: React 19, Tailwind CSS, Framer Motion, Lucide Icons.
- **Backend**: Node.js (Express), TypeScript.
- **Database**: MongoDB (Mongoose).
- **AI**: Google Gemini 3 Flash.
- **Integration**: Meta Graph API (WhatsApp/Instagram/Messenger).

## 📦 Installation & Setup

1. **Clone the repository** and install dependencies:
   ```bash
   npm install
   ```

2. **Environment Variables**:
   Create a `.env` file in the root directory and add the following:
   ```env
   MONGODB_URI=your_mongodb_connection_string
   GEMINI_API_KEY=your_google_gemini_api_key
   WHATSAPP_TOKEN=your_meta_access_token
   WHATSAPP_VERIFY_TOKEN=carmaa_secret
   ```

3. **Run the application**:
   ```bash
   npm run dev
   ```
   The app will be available at `http://localhost:3000`.

## 🔗 Meta Integration

1. Set your Webhook URL to: `https://your-domain.com/webhook`
2. Set the Verify Token to: `carmaa_secret` (or whatever you set in `.env`)
3. Subscribe to `messages` in the WhatsApp/Instagram/Messenger settings.

## 📄 License

MIT
