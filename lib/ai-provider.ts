import { GoogleGenAI } from "@google/genai";

export type AiMessage = { role: "user" | "model"; text: string };

export function hasAiKey(): boolean {
  return !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);
}

async function geminiGenerate(input: string | AiMessage[], asJson: boolean, model: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const contents = typeof input === "string"
    ? input
    : input.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  const response = await ai.models.generateContent({
    model,
    contents,
    ...(asJson ? { config: { responseMimeType: "application/json" } } : {})
  });
  const text = response.text;
  if (!text) throw new Error("Empty Gemini response");
  return text;
}

async function chatGenerate(endpoint: string, apiKey: string, model: string, input: string | AiMessage[], asJson: boolean): Promise<string> {
  const messages = typeof input === "string"
    ? [{ role: "user", content: input }]
    : input.map((m) => ({ role: m.role === "model" ? "assistant" : "user", content: m.text }));
  const body: Record<string, unknown> = { model, messages };
  if (asJson) body.response_format = { type: "json_object" };
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  let res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 400 && asJson) {
    delete body.response_format;
    res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  }
  if (!res.ok) throw new Error(`model ${res.status}`);
  const data: any = await res.json();
  const text = ((data && data.choices) || []).map((c: any) => (c && c.message && c.message.content) || "").join("").trim();
  if (!text) throw new Error("Empty response");
  return text;
}

export async function aiGenerate(input: string | AiMessage[], asJson = false, geminiModel = "gemini-2.5-flash"): Promise<string | null> {
  const attempts: (() => Promise<string>)[] = [];
  if (process.env.GEMINI_API_KEY) attempts.push(() => geminiGenerate(input, asJson, geminiModel));
  if (process.env.GROQ_API_KEY) attempts.push(() => chatGenerate("https://api.groq.com/openai/v1/chat/completions", process.env.GROQ_API_KEY!, process.env.GROQ_MODEL || "openai/gpt-oss-120b", input, asJson));
  if (process.env.OPENROUTER_API_KEY) attempts.push(() => chatGenerate("https://openrouter.ai/api/v1/chat/completions", process.env.OPENROUTER_API_KEY!, process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free", input, asJson));
  if (!attempts.length) return null;
  for (const run of attempts) {
    try {
      return await run();
    } catch (error) {
      console.error("[ai-provider] provider attempt failed:", error);
    }
  }
  return null;
}
