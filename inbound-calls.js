import WebSocket from "ws";
import fetch from "node-fetch"; // Якщо Node.js <18, інакше цей імпорт не потрібен

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  async function getSignedUrl() {
    console.log("[Server] Requesting signed URL from ElevenLabs");
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (!res.ok) {
      console.error("[Server] Failed to get signed URL:", res.statusText);
      throw new Error(`Failed to get signed URL: ${res.statusText}`);
    }
    const json = await res.json();
    console.log("[Server] Received signed URL");
    return json.signed_url;
  }

  fastify.all("/incoming-call-eleven", async (req, reply) => {
    console.log("[Server] /incoming-call-eleven requested");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream" />
        </Connect>
      </Response>`;
    reply.type("text/xml").send(xml);
  });

  fastify.register(async (instance) => {
    instance.get("/media-stream", { websocket: true }, async (conn) => {
      let streamSid = null;
      let elevenWs = null;

      console.log("[Server] Twilio WebSocket /media-stream connected");

      try {
        const signedUrl = await getSignedUrl();
        console.log("[Server] Connecting to ElevenLabs WS at:", signedUrl);
        elevenWs = new WebSocket(signedUrl);

        elevenWs.on("open", () => {
          console.log("[II] ElevenLabs WS opened");
          const init = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: { prompt: "Привіт! Я ШІ‐асистент. Як я можу допомогти?" }
              }
            }
          };
          console.log("[II] Sending init prompt to ElevenLabs");
          elevenWs.send(JSON.stringify(init));
        });

        elevenWs.on("message", (data) => {
          let msg;
          try {
            msg = JSON.parse(data);
          } catch (e) {
            console.error("[II] Error parsing ElevenLabs message:", e);
            return;
          }
          console.log("[II] Received from ElevenLabs:", msg.type);
          if (msg.type === "audio" && msg.audio_event?.audio_base_64 && streamSid) {
            console.log("[II] Forwarding audio to Twilio, streamSid:", streamSid);
            conn.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: msg.audio_event.audio_base_64 }
              })
            );
          }
          if (msg.type === "interruption" && streamSid) {
            console.log("[II] Sending clear event to Twilio");
            conn.send(JSON.stringify({ event: "clear", streamSid }));
          }
          if (msg.type === "ping" && msg.ping_event?.event_id) {
            console.log("[II] Responding to ping:", msg.ping_event.event_id);
            elevenWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
          }
        });

        elevenWs.on("error", (e) => {
          console.error("[II] ElevenLabs WS error:", e);
        });
        elevenWs.on("close", (code, reason) => {
          console.log(`[II] ElevenLabs WS closed (code: ${code}, reason: ${reason})`);
        });

        conn.on("message", (raw) => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            console.error("[Twilio] Error parsing Twilio message:", e);
            return;
          }
          console.log("[Twilio WS] Received event:", data.event);
          if (data.event === "start") {
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started: ${streamSid}`);
          }
          if (data.event === "media" && elevenWs?.readyState === WebSocket.OPEN) {
            console.log("[Twilio] Forwarding user audio to ElevenLabs");
            elevenWs.send(JSON.stringify({ user_audio_chunk: data.media.payload }));
          }
          if (data.event === "stop" && elevenWs) {
            console.log("[Twilio] Received stop, closing ElevenLabs WS");
            elevenWs.close();
          }
        });

        conn.on("close", () => {
          console.log("[Twilio] WS connection closed by client");
          if (elevenWs) elevenWs.close();
        });
        conn.on("error", (e) => {
          console.error("[Twilio] WS error:", e);
          if (elevenWs) elevenWs.close();
        });
      } catch (e) {
        console.error("[Server] Initialization error:", e);
        if (elevenWs) elevenWs.close();
        conn.socket.close();
      }
    });
  });
}
