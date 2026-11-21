import { NextRequest, NextResponse } from "next/server";
import { insforge } from "@/lib/insforge";
import { aiGenerate, hasAiKey } from "@/lib/ai-provider";

export async function POST(req: NextRequest) {
  try {
    const { userId, prompt, history = [] } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }

    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    // 1. Fetch user integrations and cached briefs
    const { data: dbUser, error: dbError } = await insforge.database
      .from("users")
      .select("integrations, dashboard_brief")
      .eq("id", userId)
      .maybeSingle();

    if (dbError || !dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const integrations = dbUser?.integrations || {};
    const isGmailConnected = !!integrations.gmail?.connected;
    const isWhatsAppConnected = !!integrations.whatsapp?.connected;

    const origin = req.nextUrl.origin;

    let gmailSummary = "No Gmail messages synced.";
    let whatsappSummary = "No WhatsApp messages synced.";

    // 2. Fetch Gmail messages as context if connected
    if (isGmailConnected) {
      try {
        const gmailRes = await fetch(`${origin}/api/gmail-mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "gmail_list_messages",
            params: { q: "label:inbox", maxResults: 5 },
            userId
          })
        });
        if (gmailRes.ok) {
          const data = await gmailRes.json();
          const text = data.result?.content?.[0]?.text;
          if (text) {
            const parsed = JSON.parse(text);
            gmailSummary = parsed.messages?.map((m: any) => 
              `From: ${m.from}\nSubject: ${m.subject}\nSnippet: ${m.snippet}\nDate: ${m.date}\nID: ${m.id}`
            ).join("\n---\n") || "No recent messages found.";
          }
        }
      } catch (e) {
        console.error("Error fetching Gmail messages in chat API:", e);
      }
    }

    // 3. Fetch WhatsApp messages as context if connected
    if (isWhatsAppConnected) {
      try {
        const waRes = await fetch(`${origin}/api/whatsapp-mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "whatsapp_get_recent_messages",
            userId
          })
        });
        if (waRes.ok) {
          const data = await waRes.json();
          const text = data.result?.content?.[0]?.text;
          if (text) {
            const parsed = JSON.parse(text);
            whatsappSummary = parsed.messages?.map((m: any) => 
              `Chat: ${m.chatName}\nSender: ${m.from}\nBody: ${m.body}\nTimestamp: ${m.timestamp}`
            ).join("\n---\n") || "No recent messages found.";
          }
        }
      } catch (e) {
        console.error("Error fetching WhatsApp messages in chat API:", e);
      }
    }

    if (!hasAiKey()) {
      return NextResponse.json({
        response: "Hello! I am in simulated mode since no AI provider key was configured. I see you connected platforms and can simulate response details here. Please configure an AI API key to chat.",
        suggestions: ["How do I connect Gmail?", "Check my updates", "Draft a template response"]
      });
    }

    const formattedHistory = history.map((h: any) => ({
      role: (h.sender === "user" ? "user" : "model") as "user" | "model",
      text: h.text
    }));
    formattedHistory.push({ role: "user", text: prompt });

    const systemPrompt = `You are OmniSync, an advanced AI Personal Assistant.
You help the user stay productive by tracking communications across their connected platforms (Gmail, WhatsApp, Slack, Outlook, Discord, LinkedIn, Telegram, etc.).

Below is the latest synced data from the user's connected applications:

=== Synced Gmail inbox context ===
${gmailSummary}

=== Synced WhatsApp chat context ===
${whatsappSummary}

Instructions:
1. Provide helpful, direct responses. If the user asks about recent emails, messages, schedules, or tasks, refer to the synced context above.
2. Format your response utilizing rich markdown:
   - Use headings (###) for sections
   - Use unordered or ordered lists for bullet points
   - Bold and italic texts to emphasize
   - Tables if comparing schedules or status
   - Code blocks (\`\`\`) with languages when rendering technical tasks or structured content.
3. Whenever you refer to a platform, write its name clearly (e.g. Gmail, WhatsApp, Slack, Outlook, Discord, LinkedIn, Telegram). The frontend will parse and replace these names with custom icons.
4. Keep the tone professional, helpful, and highly intelligent.
5. In addition to the main response text, generate 2-3 logical "quick reply suggestions" that the user might click next.
   Return the response matching EXACTLY this JSON structure:
   {
     "response": "The detailed markdown response text goes here...",
     "suggestions": [
       "Short Suggestion 1?",
       "Short Suggestion 2?",
       "Short Suggestion 3?"
     ]
   }

Make sure the JSON is valid.`;

    const textResponse = await aiGenerate([
      { role: "user", text: systemPrompt },
      ...formattedHistory
    ], true, "gemini-3.1-flash-lite");
    if (textResponse) {
      try {
        const parsed = JSON.parse(textResponse);
        return NextResponse.json(parsed);
      } catch (parseErr) {
        console.error("Failed to parse Gemini JSON:", textResponse);
        return NextResponse.json({
          response: textResponse,
          suggestions: ["Can you summarize that?", "What should I do next?", "Draft a reply email"]
        });
      }
    }

    return NextResponse.json({ error: "Failed to generate response" }, { status: 500 });

  } catch (err: any) {
    console.error("Error in AI Chat API route:", err);
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
