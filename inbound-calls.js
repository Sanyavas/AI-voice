import WebSocket from "ws";
import fetch from "node-fetch";

function generateSilenceChunk(durationMs = 100, sampleRate = 16000) {
  const numSamples = Math.floor(sampleRate * (durationMs / 1000));
  return Buffer.alloc(numSamples * 2).toString("base64");
}

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) throw new Error("No API keys");

  async function getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (!res.ok) throw new Error(`Failed to get signed URL: ${res.statusText}`);
    const json = await res.json();
    return json.signed_url;
  }

  fastify.all("/incoming-call-eleven", async (req, reply) => {
    reply.type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream" />
        </Connect>
      </Response>`
    );
  });

  fastify.register(async (instance) => {
    instance.get("/media-stream", { websocket: true }, async (conn) => {
      let streamSid = null;
      let elevenWs = null;
      try {
        const signedUrl = await getSignedUrl();
        elevenWs = new WebSocket(signedUrl);

        elevenWs.on("open", () => {
          elevenWs.send(JSON.stringify({
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: { prompt: "Привіт! Я голосовий ШІ-асистент. Як я можу допомогти?" }
              }
            }
          }));
          setTimeout(() => {
            const silenceChunk = generateSilenceChunk();
            elevenWs.send(JSON.stringify({ user_audio_chunk: silenceChunk }));
          }, 500);
        });

        elevenWs.on("message", (data) => {
          try {
            const msg = JSON.parse(data);
            if (msg.type === "audio" && msg.audio_event?.audio_base_64 && streamSid) {
              conn.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: msg.audio_event.audio_base_64 }
              }));
            }
            if (msg.type === "ping" && msg.ping_event?.event_id) {
              elevenWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
            }
            if (msg.type === "interruption" && streamSid) {
              conn.send(JSON.stringify({ event: "clear", streamSid }));
            }
          } catch (e) {
            console.error("[II] Error parsing ElevenLabs message:", e, data);
          }
        });

        conn.on("message", (raw) => {
          let data;
          try {
            data = JSON.parse(raw);
            if (data.event === "start") {
              streamSid = data.start.streamSid;
            }
            if (data.event === "media" && elevenWs?.readyState === WebSocket.OPEN) {
              elevenWs.send(JSON.stringify({ user_audio_chunk: data.media.payload }));
            }
            if (data.event === "stop" && elevenWs) {
              elevenWs.close();
            }
          } catch (e) {
            console.error("[Twilio] Error parsing message:", e, raw);
          }
        });

        conn.on("close", () => { try { elevenWs?.close(); } catch {} });
        conn.on("error", (e) => { try { elevenWs?.close(); } catch {} });
        elevenWs.on("error", (e) => { try { conn?.socket?.close(); } catch {} });
        elevenWs.on("close", () => { try { conn?.socket?.close(); } catch {} });

      } catch (e) {
        try { elevenWs?.close(); } catch {}
        try { conn?.socket?.close(); } catch {}
        console.error("[Server] Error:", e);
      }
    });
  });
}
